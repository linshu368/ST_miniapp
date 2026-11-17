import { afterEach, describe, expect, it, vi } from 'vitest';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { AlertEvaluationSchema } from '@miniapp/shared';
import type { PaymentResult } from '../../../infrastructure/payment/PaymentGateway.js';
import {
  paymentProbeGuard,
  probePaymentAvailability,
  resolvePaymentProbeClientIp,
  type PaymentAvailabilityObservation,
} from './probe.js';
import {
  executePaymentStrategies,
  validatePaymentStrategies,
  type PaymentAvailabilityStrategy,
} from './strategy.js';
import { runPaymentProbeRound, type PaymentProbeRoundResult } from './round.js';
import {
  buildPaymentAvailabilityEvaluation,
  createFeishuAlertStrategy,
} from './strategies/feishu-alert.js';
import { createSafeAlertCard } from '../../alerting/safe-card.js';

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  networkInterfaces: vi.fn(() => ({
    eth0: [{ address: '192.0.2.25', family: 'IPv4', internal: false }],
  })),
}));

const settings = { enabled: true, preview: false, channel: 'alipay' };
const observation: PaymentAvailabilityObservation = {
  kind: 'unavailable',
  channel: 'alipay',
  startedAt: '2026-11-10T01:00:00.000Z',
  observedAt: '2026-11-10T01:00:07.000Z',
  durationMs: 7000,
  errorClass: 'timeout',
};
const success: PaymentResult = {
  success: true,
  paymentUrl: 'https://secret.example/checkout',
  providerTransactionId: 'private-trade-id',
};
const newSignal = () => new AbortController().signal;
function strategy(
  id: string,
  handle = vi.fn().mockResolvedValue(undefined)
): PaymentAvailabilityStrategy {
  return { id, timeoutMs: 100, appliesTo: () => true, handle };
}
afterEach(() => vi.useRealTimers());

describe('upstream-only payment probe', () => {
  it('creates precisely one CNY 1 order and only returns a safe observation', async () => {
    const gateway = { createPayment: vi.fn().mockResolvedValue(success) };
    const result = await probePaymentAvailability({ settings, gateway, signal: newSignal() });
    expect(gateway.createPayment).toHaveBeenCalledOnce();
    expect(gateway.createPayment.mock.calls[0]![0]).toMatchObject({
      amount: '1.00',
      type: 'alipay',
      description: '星尘',
      clientIp: '192.0.2.25',
    });
    expect(gateway.createPayment.mock.calls[0]![0].orderId).toMatch(/^EP[0-9a-f]{30}$/);
    expect(result).toMatchObject({ kind: 'available', channel: 'alipay' });
    const safe = JSON.stringify(result);
    expect(safe).not.toContain('private-trade-id');
    expect(safe).not.toContain('https:');
    expect(safe).not.toContain(gateway.createPayment.mock.calls[0]![0].orderId);
  });

  it.each([
    'timeout',
    'network',
    'rate_limited',
    'provider_unavailable',
    'response_invalid',
  ] as const)(
    'does not retry a %s failure or carry raw provider information',
    async (errorClass) => {
      const gateway = {
        createPayment: vi.fn().mockResolvedValue({
          success: false,
          errorClass,
          errorMessage: 'secret raw payload',
          providerCode: 'private-code',
          outcomeUnknown: true,
        }),
      };
      const result = await probePaymentAvailability({ settings, gateway, signal: newSignal() });
      expect(result).toMatchObject({ kind: 'unavailable', errorClass });
      expect(gateway.createPayment).toHaveBeenCalledOnce();
      expect(JSON.stringify(result)).not.toMatch(/secret|private/);
    }
  );

  it('classifies a transport throw without leaking its raw error', async () => {
    const gateway = {
      createPayment: vi.fn().mockRejectedValue(new Error('https://secret.example?key=secret')),
    };
    const result = await probePaymentAvailability({ settings, gateway, signal: newSignal() });
    expect(result).toMatchObject({ kind: 'unavailable', errorClass: 'network' });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(gateway.createPayment).toHaveBeenCalledOnce();
  });

  it.each([
    [
      { ...settings, enabled: false },
      { kind: 'skipped', reason: 'disabled' },
    ],
    [
      { ...settings, preview: true },
      { kind: 'skipped', reason: 'preview' },
    ],
    [
      { ...settings, channel: 'unknown' },
      { kind: 'configuration_error', reason: 'invalid_channel' },
    ],
  ])('guards settings before calling the gateway', async (value, expected) => {
    const gateway = { createPayment: vi.fn() };
    expect(paymentProbeGuard(value)).toEqual(expected);
    expect(
      await probePaymentAvailability({ settings: value, gateway, signal: newSignal() })
    ).toEqual(expected);
    expect(gateway.createPayment).not.toHaveBeenCalled();
  });

  it('does not classify configuration errors as upstream downtime', async () => {
    const gateway = {
      createPayment: vi.fn().mockResolvedValue({ success: false, errorClass: 'configuration' }),
    };
    expect(await probePaymentAvailability({ settings, gateway, signal: newSignal() })).toEqual({
      kind: 'configuration_error',
      reason: 'gateway_configuration',
    });
  });

  it('does not publish an observation after cancellation, including a late success', async () => {
    const controller = new AbortController();
    const gateway = {
      createPayment: vi.fn(async () => {
        controller.abort();
        return success;
      }),
    };
    expect(
      await probePaymentAvailability({ settings, gateway, signal: controller.signal })
    ).toEqual({ kind: 'skipped', reason: 'aborted' });
    await probePaymentAvailability({ settings, gateway, signal: controller.signal });
    expect(gateway.createPayment).toHaveBeenCalledOnce();
  });
});

describe('automatic probe client IP', () => {
  function address(value: string, internal = false): NetworkInterfaceInfo {
    return {
      address: value,
      family: 'IPv4',
      netmask: '255.255.255.0',
      mac: '00:00:00:00:00:00',
      internal,
      cidr: null,
    };
  }

  it('selects the first non-internal valid IPv4 across local interfaces', () => {
    expect(
      resolvePaymentProbeClientIp({
        lo: [address('127.0.0.1', true)],
        missing: undefined,
        eth0: [address('invalid'), address('192.0.2.25'), address('192.0.2.26')],
        eth1: [address('198.51.100.10')],
      })
    ).toBe('192.0.2.25');
  });

  it('falls back to loopback for missing, loopback-only, or IPv6-only interfaces', () => {
    expect(resolvePaymentProbeClientIp({})).toBe('127.0.0.1');
    expect(resolvePaymentProbeClientIp({ missing: undefined })).toBe('127.0.0.1');
    expect(resolvePaymentProbeClientIp({ lo: [address('127.0.0.1', true)] })).toBe('127.0.0.1');
    expect(
      resolvePaymentProbeClientIp({
        eth0: [
          {
            ...address('2001:db8::1'),
            family: 'IPv6',
            scopeid: 0,
          },
        ],
      })
    ).toBe('127.0.0.1');
  });

  it('falls back when local interface inspection fails', () => {
    vi.mocked(networkInterfaces).mockImplementationOnce(() => {
      throw new Error('interface inspection failed');
    });
    expect(resolvePaymentProbeClientIp()).toBe('127.0.0.1');
  });
});

describe('isolated response strategies', () => {
  it('uses the same executor for one and multiple strategies and isolates errors', async () => {
    const good = strategy('good');
    expect(await executePaymentStrategies([good], observation, newSignal())).toEqual([
      { id: 'good', outcome: 'succeeded' },
    ]);
    const failed = strategy('failed', vi.fn().mockRejectedValue(new Error('sensitive detail')));
    const filtered = { ...strategy('filtered'), appliesTo: () => false };
    expect(
      await executePaymentStrategies([failed, good, filtered], observation, newSignal())
    ).toEqual([
      { id: 'failed', outcome: 'failed' },
      { id: 'good', outcome: 'succeeded' },
      { id: 'filtered', outcome: 'skipped' },
    ]);
    expect(filtered.handle).not.toHaveBeenCalled();
  });

  it('aborts a timed-out strategy while allowing another one to complete', async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    const slow = strategy(
      'slow',
      vi.fn((_result, signal: AbortSignal) => {
        receivedSignal = signal;
        return new Promise<void>((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        );
      })
    );
    const run = executePaymentStrategies([slow, strategy('good')], observation, newSignal());
    await vi.advanceTimersByTimeAsync(101);
    expect(await run).toEqual([
      { id: 'slow', outcome: 'timed_out' },
      { id: 'good', outcome: 'succeeded' },
    ]);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('bounds concurrency and does not start waiting strategies after shutdown', async () => {
    const controller = new AbortController();
    let started = 0;
    const handles = Array.from({ length: 4 }, (_, i) =>
      strategy(
        `s-${i}`,
        vi.fn(async (_result, signal: AbortSignal) => {
          started++;
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true })
          );
        })
      )
    );
    const run = executePaymentStrategies(handles, observation, controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(2);
    controller.abort();
    const results = await run;
    expect(results.slice(2).map((result) => result.outcome)).toEqual(['cancelled', 'cancelled']);
    expect(started).toBe(2);
  });

  it('rejects an invalid strategy list before executing anything', () => {
    expect(() => validatePaymentStrategies([])).toThrow();
    expect(() => validatePaymentStrategies([strategy('same'), strategy('same')])).toThrow();
    expect(() => validatePaymentStrategies([{ ...strategy('long'), timeoutMs: 30_000 }])).toThrow();
  });
});

describe('probe round boundaries', () => {
  const withLease = async (work: () => Promise<PaymentProbeRoundResult>) => ({
    acquired: true as const,
    value: await work(),
  });
  it('does not call upstream when the lease is held elsewhere', async () => {
    const gateway = { createPayment: vi.fn() };
    expect(
      await runPaymentProbeRound({
        settings,
        gateway,
        strategies: [strategy('good')],
        signal: newSignal(),
        withLease: async () => ({ acquired: false }),
      })
    ).toEqual({ outcome: 'skipped', reason: 'overlap', strategies: [] });
    expect(gateway.createPayment).not.toHaveBeenCalled();
  });
  it('does not publish on gateway configuration errors or re-probe on failed strategies', async () => {
    const gateway = { createPayment: vi.fn().mockResolvedValue(success) };
    const failed = strategy('failed', vi.fn().mockRejectedValue(new Error('failed')));
    expect(
      (
        await runPaymentProbeRound({
          settings,
          gateway,
          strategies: [failed],
          signal: newSignal(),
          withLease,
        })
      ).outcome
    ).toBe('partial');
    expect(gateway.createPayment).toHaveBeenCalledOnce();
    gateway.createPayment.mockResolvedValue({ success: false, errorClass: 'configuration' });
    vi.mocked(failed.handle).mockClear();
    expect(
      (
        await runPaymentProbeRound({
          settings,
          gateway,
          strategies: [failed],
          signal: newSignal(),
          withLease,
        })
      ).outcome
    ).toBe('error');
    expect(failed.handle).not.toHaveBeenCalled();
  });
});

describe('Feishu strategy contracts', () => {
  it('keeps a stable incident identity and emits safe, schema-valid firing and recovery', () => {
    const firing = buildPaymentAvailabilityEvaluation(observation, 'production');
    const recovered = buildPaymentAvailabilityEvaluation(
      { ...observation, kind: 'available', errorClass: undefined },
      'production'
    );
    expect(AlertEvaluationSchema.safeParse(firing).success).toBe(true);
    expect(firing.fingerprint).toBe('production:payment:upstream-create-probe:alipay');
    expect(recovered.fingerprint).toBe(firing.fingerprint);
    expect(firing.confidence).toBe('suspected');
    expect(recovered.state).toBe('healthy');
    expect(recovered.evaluation_id).not.toBe(firing.evaluation_id);
    expect(() => createSafeAlertCard(firing, 'firing', 'safe-reference')).not.toThrow();
  });
  it('propagates persistence rejection and does not invoke a cancelled publish', async () => {
    const publish = vi.fn().mockResolvedValue({ kind: 'failed', reason: 'persistence_failed' });
    const selected = createFeishuAlertStrategy({ publish }, 'test');
    expect(await executePaymentStrategies([selected], observation, newSignal())).toEqual([
      { id: 'feishu-alert', outcome: 'failed' },
    ]);
    expect(publish).toHaveBeenCalledOnce();
    const controller = new AbortController();
    controller.abort();
    await executePaymentStrategies([selected], observation, controller.signal);
    expect(publish).toHaveBeenCalledOnce();
  });
});
