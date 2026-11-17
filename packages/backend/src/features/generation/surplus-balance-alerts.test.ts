import { describe, expect, it, vi } from 'vitest';
import { AlertEvaluationSchema } from '@miniapp/shared';
import {
  SURPLUS_BALANCE_LOW_RULE_ID,
  SURPLUS_BALANCE_RECOVERY_PASSES,
  SURPLUS_USD_BALANCE_THRESHOLD,
  SurplusBalanceMonitor,
  buildSurplusBalanceEvaluation,
  isSurplusUsdBalanceLow,
  parseSurplusUsdBalance,
  probeSurplusUsdBalance,
} from './surplus-balance-alerts.js';

describe('parseSurplusUsdBalance', () => {
  it('converts the documented spendable microdollar string to USD', () => {
    expect(parseSurplusUsdBalance({ credit_balance_usdc: '9500000' })).toEqual({
      usd: 9.5,
    });
    expect(parseSurplusUsdBalance({ credit_balance_usdc: '0' })).toEqual({
      usd: 0,
    });
  });

  it.each([
    { credit_balance_usdc: '9.5' },
    { credit_balance_usdc: '-1' },
    { credit_balance_usdc: 9_500_000 },
    { balance_usdc: '9500000' },
    { allowance_usdc: '9500000' },
    {},
  ])('rejects invalid or legacy balance payload %#', (body) => {
    expect(parseSurplusUsdBalance(body)).toBeNull();
  });
});

describe('Surplus balance policy', () => {
  it('fires strictly below the existing ten-dollar threshold', () => {
    expect(isSurplusUsdBalanceLow(9.99)).toBe(true);
    expect(isSurplusUsdBalanceLow(SURPLUS_USD_BALANCE_THRESHOLD)).toBe(false);
  });

  it('builds a provider-scoped P1 evaluation without account data', () => {
    const evaluation = buildSurplusBalanceEvaluation({
      usd: 8.25,
      firing: true,
      now: new Date('2026-11-06T12:00:00.000Z'),
      environment: 'test',
    });
    expect(AlertEvaluationSchema.safeParse(evaluation).success).toBe(true);
    expect(evaluation.rule_id).toBe(SURPLUS_BALANCE_LOW_RULE_ID);
    expect(evaluation.fingerprint).toBe('test:generation:surplus:balance_low');
    expect(evaluation.severity).toBe('P1');
    expect(evaluation.metrics.find((metric) => metric.name === 'balance_usd_cents')?.value).toBe(
      825
    );
    expect(JSON.stringify(evaluation)).not.toContain('account-1');
  });
});

describe('probeSurplusUsdBalance', () => {
  it('skips when the API key is missing', async () => {
    await expect(
      probeSurplusUsdBalance({
        apiKey: '',
        baseUrl: 'https://surplus.example/api/v1',
        fetchImpl: vi.fn(),
      })
    ).resolves.toEqual({ kind: 'skipped', reason: 'missing_api_key' });
  });

  it('uses the configured base and key without retrying authentication failures', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(
      probeSurplusUsdBalance({
        apiKey: 'surplus-test-key',
        baseUrl: 'https://surplus.example/custom/v1/',
        fetchImpl,
        attempts: 2,
      })
    ).resolves.toEqual({ kind: 'probe_failed', reason: 'auth_failed' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://surplus.example/custom/v1/payments/balance',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer surplus-test-key',
          Accept: 'application/json',
        },
      })
    );
  });

  it('retries a 5xx once and returns the parsed balance', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ credit_balance_usdc: '4200000' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    await expect(
      probeSurplusUsdBalance({
        apiKey: 'surplus-test-key',
        baseUrl: 'https://surplus.example/api/v1',
        fetchImpl,
      })
    ).resolves.toEqual({ kind: 'ok', snapshot: { usd: 4.2 } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry an invalid successful response', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ credit_balance_usdc: 'four' }), { status: 200 })
      );
    await expect(
      probeSurplusUsdBalance({
        apiKey: 'surplus-test-key',
        baseUrl: 'https://surplus.example/api/v1',
        fetchImpl,
      })
    ).resolves.toEqual({ kind: 'probe_failed', reason: 'invalid_body' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('SurplusBalanceMonitor', () => {
  function setup(probe: () => ReturnType<typeof probeSurplusUsdBalance>) {
    const published: Array<{ state: string; notify?: boolean }> = [];
    const monitor = new SurplusBalanceMonitor(
      {
        publish: vi.fn(async (evaluation: never, options?: { notify?: boolean }) => {
          published.push({
            state: (evaluation as { state: string }).state,
            notify: options?.notify,
          });
          return { kind: 'accepted' };
        }),
      },
      { biz: { info: vi.fn() }, sys: { warn: vi.fn(), error: vi.fn() } } as never,
      probe
    );
    return { monitor, published };
  }

  it('publishes firing evaluations while low and relies on outbox dedupe', async () => {
    const { monitor, published } = setup(async () => ({
      kind: 'ok',
      snapshot: { usd: 3 },
    }));
    await monitor.runOnce(new Date('2026-11-06T12:00:00.000Z'));
    await monitor.runOnce(new Date('2026-11-06T12:01:00.000Z'));
    expect(published).toEqual([
      { state: 'firing', notify: true },
      { state: 'firing', notify: true },
    ]);
  });

  it('requires consecutive healthy passes before recovery', async () => {
    let usd = 3;
    const { monitor, published } = setup(async () => ({ kind: 'ok', snapshot: { usd } }));
    await monitor.runOnce(new Date('2026-11-06T12:00:00.000Z'));
    usd = 12;
    for (let pass = 1; pass < SURPLUS_BALANCE_RECOVERY_PASSES; pass += 1) {
      await monitor.runOnce(new Date(`2026-11-06T12:0${pass}:00.000Z`));
    }
    expect(published.filter((entry) => entry.state === 'healthy')).toHaveLength(0);
    await monitor.runOnce(new Date('2026-11-06T12:05:00.000Z'));
    expect(published.filter((entry) => entry.state === 'healthy')).toHaveLength(1);
  });

  it('does not publish healthy after a probe failure', async () => {
    const { monitor, published } = setup(async () => ({
      kind: 'probe_failed',
      reason: 'timeout',
    }));
    await expect(monitor.runOnce()).resolves.toEqual({ published: 0, outcome: 'probe_failed' });
    expect(published).toEqual([]);
  });

  it('requires healthy passes to be consecutive across a probe failure', async () => {
    const results = [
      { kind: 'ok' as const, snapshot: { usd: 12 } },
      { kind: 'probe_failed' as const, reason: 'timeout' as const },
      { kind: 'ok' as const, snapshot: { usd: 12 } },
    ];
    const { monitor, published } = setup(async () => results.shift()!);
    await monitor.runOnce();
    await monitor.runOnce();
    await monitor.runOnce();
    expect(published).toEqual([]);
  });
});
