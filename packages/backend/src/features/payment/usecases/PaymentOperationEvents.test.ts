import { describe, expect, it, vi } from 'vitest';

import { recordPaymentOperationEvent } from './PaymentOperationEvents.js';
import type { SettlementLogger } from './PaymentSettlement.js';

function log() {
  const sink = { error: vi.fn(), info: vi.fn() };
  return { logger: { sys: sink, biz: sink } as unknown as SettlementLogger, sink };
}

describe('recordPaymentOperationEvent', () => {
  it('contains a side-channel write failure without changing the caller outcome', async () => {
    const recorder = {
      recordOperationEvent: vi.fn(async () => {
        throw new Error('events unavailable');
      }),
    };
    const { logger, sink } = log();

    expect(() =>
      recordPaymentOperationEvent(recorder as never, logger, {
        event_key: 'settlement:webhook:succeeded:MA-1:none',
        order_id: 'MA-1',
        user_id: null,
        event_kind: 'settlement',
        stage: 'settlement',
        outcome: 'succeeded',
        source: 'backend',
        trigger: 'settlement',
        occurred_at: '2026-10-10T12:00:00.000Z',
      })
    ).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recorder.recordOperationEvent).toHaveBeenCalledOnce();
    expect(sink.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'payment.operation_event.record_failed',
        stage: 'settlement',
      }),
      '支付操作旁路采集失败'
    );
  });
});
