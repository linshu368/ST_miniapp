import { describe, expect, it, vi } from 'vitest';

import { recordPaymentOperationEvent } from './PaymentOperationEvents.js';
import type { SettlementLogger } from './PaymentSettlement.js';
import { createObserver } from '../../../platform/observability/core.js';
import type { ObservationEvent } from '../../../platform/observability/events.js';
import { observation } from '../../../platform/observability/runtime.js';

function log() {
  const sink = { error: vi.fn(), info: vi.fn() };
  return { logger: { sys: sink, biz: sink } as unknown as SettlementLogger, sink };
}

describe('recordPaymentOperationEvent', () => {
  it('correlates a verified internal user from a payment event outside an HTTP request', () => {
    const spy = vi.spyOn(observation, 'emit');
    const user_id = '11111111-1111-4111-8111-111111111111';
    try {
      recordPaymentOperationEvent(undefined, log().logger, {
        event_key: 'private-key',
        order_id: 'private-order',
        user_id,
        event_kind: 'settlement',
        stage: 'settlement',
        outcome: 'succeeded',
        source: 'backend',
        trigger: 'settlement',
        occurred_at: '2026-11-14T00:00:00Z',
      });
      expect(spy).toHaveBeenCalledWith(
        'payment.operation',
        'payment.settlement',
        expect.objectContaining({ user_id, business_module: 'payment' }),
        undefined
      );
      expect(JSON.stringify(spy.mock.calls)).not.toContain('private');
    } finally {
      spy.mockRestore();
    }
  });
  it('emits safe payment facts without requiring a side-channel database recorder', () => {
    const spy = vi.spyOn(observation, 'emit');
    try {
      recordPaymentOperationEvent(undefined, log().logger, {
        event_key: 'private-key',
        order_id: 'private-order',
        user_id: 'private-user',
        event_kind: 'gateway_create',
        stage: 'gateway',
        outcome: 'failed',
        source: 'backend',
        trigger: 'create_order',
        occurred_at: '2026-11-13T00:00:00Z',
        error_class: 'timeout',
        metadata: { raw: 'private-content' },
      });
      expect(spy).toHaveBeenCalledWith(
        'payment.operation',
        'payment.gateway_create',
        expect.objectContaining({
          outcome: 'failed',
          outcome_known: false,
          error_code: 'timeout',
          business_key: expect.stringMatching(/^[a-f0-9]{24}$/),
        }),
        undefined
      );
      expect(JSON.stringify(spy.mock.calls)).not.toContain('private-');
    } finally {
      spy.mockRestore();
    }
  });
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

describe('reconciliation failure severity', () => {
  it.each(['fast_reconcile', 'expiry_reconcile'] as const)(
    'warns for retryable %s failures without dropping failed facts',
    async (kind) => {
      const emitted: ObservationEvent[] = [];
      const observer = createObserver([
        (event) => {
          emitted.push(event);
        },
      ]);
      const spy = vi.spyOn(observation, 'emit').mockImplementation(observer.emit);
      const recorder = { recordOperationEvent: vi.fn(async (_event: unknown) => undefined) };
      try {
        for (const error_class of [
          'provider_unavailable',
          'network',
          'timeout',
          'rate_limited',
          'configuration',
          'response_invalid',
        ]) {
          recordPaymentOperationEvent(
            recorder,
            log().logger,
            {
              event_key: error_class,
              order_id: 'private-order',
              user_id: null,
              event_kind: kind,
              stage: 'query',
              outcome: 'failed',
              source: 'gateway',
              trigger: kind,
              occurred_at: new Date().toISOString(),
              error_class,
            },
            '500'
          );
        }
        await Promise.resolve();
        expect(emitted.map((e) => e.level)).toEqual([
          'warn',
          'warn',
          'warn',
          'warn',
          'error',
          'error',
        ]);
        expect(emitted.every((e) => e.outcome === 'failed' && e.outcome_known === false)).toBe(
          true
        );
        expect(recorder.recordOperationEvent).toHaveBeenCalledTimes(6);
        expect(recorder.recordOperationEvent.mock.calls[0]?.[0]).toMatchObject({
          outcome: 'failed',
          error_class: 'provider_unavailable',
        });
        expect(JSON.stringify(emitted)).not.toContain('private-order');
      } finally {
        spy.mockRestore();
      }
    }
  );
});

describe('provider protocol code projection', () => {
  it.each([
    ['500', '500'],
    ['HTTP_403', 'HTTP_403'],
    ['key=private-secret', undefined],
    ['99999', undefined],
  ])('projects only bounded protocol codes (%s)', (providerCode, expected) => {
    const emitted: ObservationEvent[] = [];
    const observer = createObserver([
      (event) => {
        emitted.push(event);
      },
    ]);
    const spy = vi.spyOn(observation, 'emit').mockImplementation(observer.emit);
    try {
      recordPaymentOperationEvent(
        undefined,
        log().logger,
        {
          event_key: 'fixture',
          order_id: null,
          user_id: null,
          event_kind: 'fast_reconcile',
          stage: 'query',
          outcome: 'failed',
          source: 'gateway',
          trigger: 'fast_reconcile',
          occurred_at: new Date().toISOString(),
          error_class: 'provider_unavailable',
        },
        providerCode
      );
      expect(emitted[0]?.code).toBe(expected);
      expect(JSON.stringify(emitted)).not.toContain('private-secret');
    } finally {
      spy.mockRestore();
    }
  });
});
