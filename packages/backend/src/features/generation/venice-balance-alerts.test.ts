import { describe, expect, it, vi } from 'vitest';
import { AlertEvaluationSchema } from '@miniapp/shared';
import {
  VENICE_BALANCE_LOW_RULE_ID,
  VENICE_BALANCE_RECOVERY_PASSES,
  VENICE_USD_BALANCE_THRESHOLD,
  VeniceBalanceMonitor,
  buildVeniceBalanceEvaluation,
  isVeniceUsdBalanceLow,
  parseVeniceUsdBalance,
  probeVeniceUsdBalance,
} from './venice-balance-alerts.js';

describe('parseVeniceUsdBalance', () => {
  it('treats null usd as zero and keeps canConsume', () => {
    expect(
      parseVeniceUsdBalance({
        canConsume: true,
        balances: { usd: null, diem: 50, bundledCredits: 1, earnedCredits: 2 },
      })
    ).toEqual({ usd: 0, canConsume: true });
  });

  it('rejects non-finite usd without reading other credit fields as usd', () => {
    expect(
      parseVeniceUsdBalance({
        canConsume: false,
        balances: { usd: '9', diem: 100 },
      })
    ).toBeNull();
  });

  it('parses a positive usd balance', () => {
    expect(
      parseVeniceUsdBalance({
        canConsume: true,
        balances: { usd: 9.5 },
      })
    ).toEqual({ usd: 9.5, canConsume: true });
  });
});

describe('isVeniceUsdBalanceLow', () => {
  it('fires strictly below the threshold', () => {
    expect(isVeniceUsdBalanceLow(9.99)).toBe(true);
    expect(isVeniceUsdBalanceLow(VENICE_USD_BALANCE_THRESHOLD)).toBe(false);
    expect(isVeniceUsdBalanceLow(10.01)).toBe(false);
  });
});

describe('buildVeniceBalanceEvaluation', () => {
  it('builds a safe generation-domain evaluation', () => {
    const evaluation = buildVeniceBalanceEvaluation({
      usd: 8.25,
      canConsume: true,
      firing: true,
      now: new Date('2026-11-05T12:00:00.000Z'),
      environment: 'test',
    });
    expect(AlertEvaluationSchema.safeParse(evaluation).success).toBe(true);
    expect(evaluation.domain).toBe('generation');
    expect(evaluation.rule_id).toBe(VENICE_BALANCE_LOW_RULE_ID);
    expect(evaluation.fingerprint).toBe('test:generation:venice:balance_low');
    expect(evaluation.severity).toBe('P1');
    expect(evaluation.metrics.find((m) => m.name === 'balance_usd_cents')?.value).toBe(825);
  });
});

describe('probeVeniceUsdBalance', () => {
  it('skips when api key is missing', async () => {
    await expect(
      probeVeniceUsdBalance({
        apiKey: '',
        baseUrl: 'https://api.venice.ai/api/v1',
        fetchImpl: vi.fn(),
      })
    ).resolves.toEqual({ kind: 'skipped', reason: 'missing_api_key' });
  });

  it('maps 401 to auth_failed without retrying as success', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }));
    await expect(
      probeVeniceUsdBalance({
        apiKey: 'admin-key',
        baseUrl: 'https://api.venice.ai/api/v1',
        fetchImpl: fetchImpl as never,
        attempts: 2,
      })
    ).resolves.toEqual({ kind: 'probe_failed', reason: 'auth_failed' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns parsed usd on 200', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            canConsume: true,
            balances: { usd: 4.2, diem: null, bundledCredits: null, earnedCredits: null },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    await expect(
      probeVeniceUsdBalance({
        apiKey: 'admin-key',
        baseUrl: 'https://api.venice.ai/api/v1',
        fetchImpl: fetchImpl as never,
      })
    ).resolves.toEqual({
      kind: 'ok',
      snapshot: { usd: 4.2, canConsume: true },
    });
  });
});

describe('VeniceBalanceMonitor', () => {
  function setup(probe: () => ReturnType<typeof probeVeniceUsdBalance>) {
    const published: Array<{ state: string; notify?: boolean }> = [];
    const monitor = new VeniceBalanceMonitor(
      {
        publish: vi.fn(async (evaluation: never, options?: { notify?: boolean }) => {
          const e = evaluation as { state: string };
          published.push({ state: e.state, notify: options?.notify });
          return { kind: 'accepted' };
        }),
      },
      { biz: { info: vi.fn() }, sys: { warn: vi.fn(), error: vi.fn() } } as never,
      probe
    );
    return { monitor, published };
  }

  it('keeps publishing firing evaluations while balance stays low (publisher dedupes)', async () => {
    const { monitor, published } = setup(async () => ({
      kind: 'ok',
      snapshot: { usd: 3, canConsume: true },
    }));
    await monitor.runOnce(new Date('2026-11-05T12:00:00.000Z'));
    await monitor.runOnce(new Date('2026-11-05T12:01:00.000Z'));
    expect(published.filter((p) => p.state === 'firing')).toHaveLength(2);
    expect(published.every((p) => p.notify === true)).toBe(true);
  });

  it('requires consecutive healthy passes before recovered', async () => {
    let usd = 3;
    const { monitor, published } = setup(async () => ({
      kind: 'ok',
      snapshot: { usd, canConsume: true },
    }));
    await monitor.runOnce(new Date('2026-11-05T12:00:00.000Z'));
    usd = 12;
    for (let i = 1; i < VENICE_BALANCE_RECOVERY_PASSES; i += 1) {
      await monitor.runOnce(new Date(`2026-11-05T12:0${i}:00.000Z`));
    }
    expect(published.filter((p) => p.state === 'healthy')).toHaveLength(0);
    await monitor.runOnce(new Date('2026-11-05T12:05:00.000Z'));
    expect(published.filter((p) => p.state === 'healthy')).toHaveLength(1);
  });

  it('does not publish healthy after probe failure', async () => {
    const { monitor, published } = setup(async () => ({
      kind: 'probe_failed',
      reason: 'timeout',
    }));
    await expect(monitor.runOnce()).resolves.toEqual({
      published: 0,
      outcome: 'probe_failed',
    });
    expect(published).toEqual([]);
  });
});
