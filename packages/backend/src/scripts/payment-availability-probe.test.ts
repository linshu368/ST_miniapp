import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  settings: { enabled: false, preview: false, channel: 'alipay' },
  createPayment: vi.fn(),
  publish: vi.fn(),
  disconnect: vi.fn(),
  observe: vi.fn(),
  stop: vi.fn(),
  dbLoads: 0,
  overlap: false,
  log: { biz: { info: vi.fn() }, sys: { error: vi.fn(), warn: vi.fn() } },
}));
vi.mock('../instrumentation.js', () => ({}));
vi.mock('../platform/config.js', () => ({
  config: { paymentProbe: state.settings, database: { environment: 'test' } },
}));
vi.mock('../lib/logger.js', () => ({ createLogger: () => state.log }));
vi.mock('../lib/background-observability.js', () => ({
  observeBackgroundRun: state.observe,
  startStandaloneObservability: () => state.stop,
}));
vi.mock('../lib/postgres-advisory-lease.js', () => ({
  withSessionAdvisoryLock: async (_key: number, work: () => Promise<unknown>) => ({
    ...(state.overlap ? { acquired: false } : { acquired: true, value: await work() }),
  }),
}));
vi.mock('../infrastructure/payment/EpayPaymentGateway.js', () => ({
  EpayPaymentGateway: class {
    createPayment = state.createPayment;
  },
}));
vi.mock('../features/alerting/publisher.js', () => ({
  AlertPublisher: class {
    publish = state.publish;
  },
}));
vi.mock('../features/alerting/repository.js', () => ({ PrismaAlertPersistence: class {} }));
vi.mock('../lib/db.js', () => {
  state.dbLoads++;
  return { prisma: { $disconnect: state.disconnect } };
});

describe('standalone payment probe process wiring', () => {
  const originalExitCode = process.exitCode;
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    state.settings.enabled = false;
    state.settings.preview = false;
    state.settings.channel = 'alipay';
    state.overlap = false;
    state.dbLoads = 0;
    state.createPayment.mockResolvedValue({
      success: true,
      paymentUrl: 'https://checkout.example',
      providerTransactionId: 'private-trade',
    });
    state.publish.mockResolvedValue({ kind: 'accepted' });
    state.disconnect.mockResolvedValue(undefined);
    state.stop.mockResolvedValue(undefined);
  });
  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.useRealTimers();
  });

  it.each(['disabled', 'preview'] as const)(
    'skips %s without initializing the database or upstream',
    async (reason) => {
      state.settings.enabled = reason === 'preview';
      state.settings.preview = reason === 'preview';
      await import('./payment-availability-probe.js');
      expect(state.dbLoads).toBe(0);
      expect(state.createPayment).not.toHaveBeenCalled();
      expect(state.publish).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
      expect(state.observe).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'skipped' }));
      expect(state.log.biz.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'payment.probe.guarded',
          outcome: 'skipped',
          probe_result: 'skipped',
          reason,
        }),
        expect.any(String)
      );
    }
  );

  it('publishes the one safe observation and disconnects the independent process pool', async () => {
    state.settings.enabled = true;
    await import('./payment-availability-probe.js');
    expect(state.createPayment).toHaveBeenCalledOnce();
    expect(state.publish).toHaveBeenCalledOnce();
    expect(state.disconnect).toHaveBeenCalledOnce();
    expect(state.stop).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(0);
    expect(JSON.stringify(state.log.biz.info.mock.calls)).not.toContain('private-trade');
    expect(state.log.biz.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'payment.probe.completed',
        outcome: 'success',
        probe_result: 'available',
        paymentType: 'alipay',
        strategy_success_count: 1,
        strategy_failed_count: 0,
      }),
      expect.any(String)
    );
    const summary = state.log.biz.info.mock.calls[0]![0];
    expect(summary).not.toHaveProperty('probe');
    expect(summary).not.toHaveProperty('strategies');
  });

  it('reports partial when alert persistence fails, without re-probing', async () => {
    state.settings.enabled = true;
    state.publish.mockResolvedValue({ kind: 'failed', reason: 'persistence_failed' });
    await import('./payment-availability-probe.js');
    expect(state.createPayment).toHaveBeenCalledOnce();
    expect(state.disconnect).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    expect(state.observe).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'partial' }));
    expect(state.log.biz.info).toHaveBeenCalledWith(
      expect.objectContaining({
        probe_result: 'available',
        outcome: 'partial',
        strategy_failed_count: 1,
      }),
      expect.any(String)
    );
  });

  it.each(['invalid_channel', 'gateway_configuration'] as const)(
    'reports configuration failure distinctly: %s',
    async (reason) => {
      state.settings.enabled = true;
      if (reason === 'invalid_channel') state.settings.channel = 'invalid';
      else state.createPayment.mockResolvedValue({ success: false, errorClass: 'configuration' });
      await import('./payment-availability-probe.js');
      expect(state.log.biz.info).toHaveBeenCalledWith(
        expect.objectContaining({ probe_result: 'configuration_error', reason }),
        expect.any(String)
      );
      expect(state.publish).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    }
  );

  it('shows actual unavailable result and a safe error classification', async () => {
    state.settings.enabled = true;
    state.createPayment.mockResolvedValue({
      success: false,
      errorClass: 'timeout',
      errorMessage: 'private',
    });
    await import('./payment-availability-probe.js');
    expect(state.log.biz.info).toHaveBeenCalledWith(
      expect.objectContaining({
        probe_result: 'unavailable',
        errorClass: 'timeout',
        outcome: 'partial',
      }),
      expect.any(String)
    );
    expect(JSON.stringify(state.log.biz.info.mock.calls)).not.toContain('private');
  });

  it('reports overlap without inventing a probe result or sending a request', async () => {
    state.settings.enabled = true;
    state.overlap = true;
    await import('./payment-availability-probe.js');
    expect(state.log.biz.info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'skipped', reason: 'overlap' }),
      expect.any(String)
    );
    expect(state.createPayment).not.toHaveBeenCalled();
    expect(state.publish).not.toHaveBeenCalled();
  });

  it('cancels outstanding work before the hard deadline and still cleans up', async () => {
    vi.useFakeTimers();
    state.settings.enabled = true;
    state.createPayment.mockImplementation(
      async (_params: unknown, signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ success: false, errorClass: 'timeout' }),
            { once: true }
          );
        })
    );
    const run = import('./payment-availability-probe.js');
    await vi.waitFor(() => expect(state.createPayment).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(45_000);
    await run;
    expect(state.publish).not.toHaveBeenCalled();
    expect(state.disconnect).toHaveBeenCalledOnce();
    expect(state.stop).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
