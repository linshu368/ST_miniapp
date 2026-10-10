import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  row: null as unknown,
  executeRaw: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock('../../lib/db.js', () => ({
  prisma: {
    $transaction: (
      callback: (tx: {
        $queryRaw: () => Promise<unknown>;
        $executeRaw: typeof state.executeRaw;
      }) => Promise<unknown>
    ) =>
      callback({
        $queryRaw: async () => (state.row ? [state.row] : []),
        $executeRaw: state.executeRaw,
      }),
    $executeRaw: state.executeRaw,
  },
}));

import { AlertDeliveryWorker } from './delivery-worker.js';

const config = {
  notifications_enabled: true,
  feishu_timeout_ms: 1000,
  max_attempts: 3,
  min_delivery_interval_ms: 0,
};
const log = { biz: { info: vi.fn() }, sys: { warn: vi.fn() } } as never;

describe('AlertDeliveryWorker', () => {
  beforeEach(() => {
    state.row = {
      id: 1n,
      notification_key: 'test:logs:availability:all:firing:x',
      payload: {},
      attempt_count: 1,
    };
    state.executeRaw.mockReset();
  });

  it('keeps 429 delivery outside publishing and schedules a bounded retry', async () => {
    const sink = {
      deliver: vi
        .fn()
        .mockResolvedValue({ kind: 'retryable', errorClass: 'http_429', retryAfterMs: 2000 }),
    };
    const worker = new AlertDeliveryWorker(sink as never, log, async () => config);
    await expect(worker.deliverOne()).resolves.toBe('retrying');
    expect(state.executeRaw).toHaveBeenCalledTimes(1);
  });

  it('abandons a notification after finite retry exhaustion', async () => {
    state.row = {
      id: 1n,
      notification_key: 'test:logs:availability:all:firing:x',
      payload: {},
      attempt_count: 3,
    };
    const sink = {
      deliver: vi.fn().mockResolvedValue({ kind: 'retryable', errorClass: 'timeout' }),
    };
    const worker = new AlertDeliveryWorker(sink as never, log, async () => config);
    await expect(worker.deliverOne()).resolves.toBe('abandoned');
    expect(state.executeRaw).toHaveBeenCalledTimes(1);
  });

  it('does not call Feishu for a P1 card', async () => {
    state.row = {
      id: 1n,
      notification_key: 'development:payment:p1-05:all:firing:x',
      payload: {
        severity: 'P1',
        incident_fingerprint: 'development:payment:p1-05:all',
      },
      attempt_count: 1,
    };
    const sink = { deliver: vi.fn() };
    const worker = new AlertDeliveryWorker(sink as never, log, async () => config);
    await expect(worker.deliverOne()).resolves.toBe('abandoned');
    expect(sink.deliver).not.toHaveBeenCalled();
  });

  it('does not claim or call Feishu while notifications are disabled', async () => {
    const sink = { deliver: vi.fn() };
    const worker = new AlertDeliveryWorker(sink as never, log, async () => ({
      ...config,
      notifications_enabled: false,
    }));
    await expect(worker.deliverOne()).resolves.toBe('disabled');
    expect(sink.deliver).not.toHaveBeenCalled();
  });
});
