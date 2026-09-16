import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentOrder } from '@miniapp/shared';

import {
  capturePaymentOrderStatusObserved,
  forgetPaymentReturnMemoryForTests,
  markExternalPaymentOpened,
  noteExternalPaymentBackgrounded,
  observePaymentReturn,
  resetPaymentFlowTelemetryForTests,
  safePaymentReturnRoute,
} from './flow-telemetry';
import { EXTERNAL_PAYMENT_PENDING_TTL_MS } from './external-payment-pending';
import { setReplaySessionStorageForTests } from './session-storage';
import { writePaywallContinuation } from './paywall-continuation';

type Snapshot = {
  state: 'idle' | 'chat' | 'paywall_followup' | 'external_payment_pending' | 'ended';
  replayContextId: string | null;
  telemetryReady: boolean;
  streaming: boolean;
};

const capture = vi.fn();
const getSnapshot = vi.fn(
  (): Snapshot => ({
    state: 'external_payment_pending',
    replayContextId: '11111111-1111-4111-8111-111111111111',
    telemetryReady: true,
    streaming: false,
  })
);

vi.mock('@/lib/telemetry', () => ({
  getReplayLifecycle: () => ({
    capture,
    getSnapshot,
    enterPaywallFollowup: vi.fn(),
  }),
}));

const order: PaymentOrder = {
  id: 'TG_1',
  status: 'pending',
  payment_type: 'wxpay',
  amount_cents: 600,
  credits_amount: 100,
  bonus_credits: 0,
  created_at: new Date('2026-09-15T00:00:00.000Z').toISOString(),
  expires_at: new Date('2026-09-15T00:15:00.000Z').toISOString(),
  paid_at: null,
  provider_transaction_id: null,
  settled_by: null,
};

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

function capturedEvents(): Array<{ event?: string; order_id?: string | null }> {
  return capture.mock.calls.map((call) => call[0] as { event?: string; order_id?: string | null });
}

function capturedPayload(): string {
  return JSON.stringify(capture.mock.calls);
}

beforeEach(() => {
  capture.mockClear();
  getSnapshot.mockReturnValue({
    state: 'external_payment_pending',
    replayContextId: '11111111-1111-4111-8111-111111111111',
    telemetryReady: true,
    streaming: false,
  });
  setReplaySessionStorageForTests(memoryStorage());
  resetPaymentFlowTelemetryForTests();
  writePaywallContinuation({
    triggerSource: 'chat_sse',
    returnTo:
      '/chat/22222222-2222-4222-8222-222222222222?session=33333333-3333-4333-8333-333333333333',
    replayContextId: '11111111-1111-4111-8111-111111111111',
    now: 1_000,
  });
});

afterEach(() => {
  resetPaymentFlowTelemetryForTests();
  setReplaySessionStorageForTests(undefined);
});

describe('payment flow telemetry', () => {
  it('records order status once per order_id + state + settled_by', () => {
    capturePaymentOrderStatusObserved(order);
    capturePaymentOrderStatusObserved(order);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capturedPayload()).not.toContain('pay_url');

    capturePaymentOrderStatusObserved({ ...order, status: 'completed', settled_by: 'return' });
    expect(capture).toHaveBeenCalledTimes(2);
  });
});

describe('payment return observed', () => {
  it('records return from start_param redirect and keeps the pending order id', () => {
    markExternalPaymentOpened({ orderId: 'TG_1', paymentType: 'wxpay', now: 1_000 });
    expect(
      observePaymentReturn({
        source: 'start_param',
        orderId: 'TG_1',
        route: '/profile/recharge/TG_1?payment=returned&pay_url=https://pay.example/x',
        now: 4_000,
      })
    ).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]?.[0]).toMatchObject({
      event: 'payment_return_observed',
      order_id: 'TG_1',
      return_surface: 'order_detail',
      payment_type: 'wxpay',
      return_source: 'start_param',
      return_route: '/profile/recharge/TG_1',
      elapsed_ms: 3_000,
    });
    expect(capturedPayload()).not.toContain('pay_url');
    expect(capturedPayload()).not.toContain('pay.example');
  });

  it('fills order_id when returning to /profile/orders without a query order id', () => {
    markExternalPaymentOpened({ orderId: 'TG_1', paymentType: 'wxpay', now: 1_000 });
    noteExternalPaymentBackgrounded(2_000);
    expect(
      observePaymentReturn({
        source: 'webview_resume',
        route: '/profile/orders',
        now: 2_500,
      })
    ).toBe(true);
    expect(capture.mock.calls[0]?.[0]).toMatchObject({
      event: 'payment_return_observed',
      order_id: 'TG_1',
      return_surface: 'orders_list',
      return_source: 'webview_resume',
      return_route: '/profile/orders',
      payment_type: 'wxpay',
    });
  });

  it('records return to an order detail route with the same order_id as status', () => {
    markExternalPaymentOpened({ orderId: 'TG_1', paymentType: 'wxpay', now: 1_000 });
    expect(
      observePaymentReturn({
        source: 'query_param',
        orderId: 'TG_1',
        route: '/profile/recharge/TG_1',
        now: 2_000,
      })
    ).toBe(true);
    capturePaymentOrderStatusObserved(order);
    const events = capturedEvents();
    expect(events.map((item) => item.event)).toEqual([
      'payment_return_observed',
      'payment_order_status_observed',
    ]);
    expect(events[0]?.order_id).toBe('TG_1');
    expect(events[1]?.order_id).toBe('TG_1');
    expect(events.map((item) => item.event)).not.toContain('payment_order_settled');
    expect(events.map((item) => item.event)).not.toContain('payment_order_failed');
  });

  it('does not treat a still-pending order as completed or failed after return', () => {
    markExternalPaymentOpened({ orderId: 'TG_1', paymentType: 'wxpay', now: 1_000 });
    noteExternalPaymentBackgrounded(2_000);
    observePaymentReturn({ source: 'webview_resume', route: '/profile/orders', now: 2_000 });
    capturePaymentOrderStatusObserved(order);
    expect(capturedEvents().every((item) => item.event !== 'payment_order_settled')).toBe(true);
    expect(capturedEvents().every((item) => item.event !== 'payment_order_failed')).toBe(true);
    expect(capturedEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'payment_order_status_observed',
          order_id: 'TG_1',
          order_status: 'pending',
        }),
      ])
    );
  });

  it('ignores ordinary focus and visibility when external payment was never opened', () => {
    expect(
      observePaymentReturn({ source: 'webview_resume', route: '/profile/orders', now: 2_000 })
    ).toBe(false);
    markExternalPaymentOpened({ orderId: 'TG_1', paymentType: 'wxpay', now: 1_000 });
    expect(
      observePaymentReturn({ source: 'webview_resume', route: '/profile/orders', now: 2_000 })
    ).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });

  it('reports a URL-unchanged resume only once across focus, visibility and pageshow', () => {
    markExternalPaymentOpened({ orderId: 'TG_1', paymentType: 'wxpay', now: 1_000 });
    noteExternalPaymentBackgrounded(2_000);
    expect(
      observePaymentReturn({
        source: 'webview_resume',
        route: '/profile/recharge/TG_1',
        now: 2_000,
      })
    ).toBe(true);
    expect(
      observePaymentReturn({
        source: 'webview_resume',
        route: '/profile/recharge/TG_1',
        now: 2_100,
      })
    ).toBe(false);
    expect(
      observePaymentReturn({
        source: 'query_param',
        orderId: 'TG_1',
        route: '/profile/recharge/TG_1?payment=returned',
        now: 2_200,
      })
    ).toBe(false);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('does not resume after pending storage expires', () => {
    markExternalPaymentOpened({ orderId: 'TG_1', paymentType: 'wxpay', now: 1_000 });
    noteExternalPaymentBackgrounded(1_000);
    expect(
      observePaymentReturn({
        source: 'webview_resume',
        route: '/profile/orders',
        now: 1_000 + EXTERNAL_PAYMENT_PENDING_TTL_MS + 1,
      })
    ).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });

  it('keeps the in-memory pending order when sessionStorage is unavailable', () => {
    setReplaySessionStorageForTests(null);
    markExternalPaymentOpened({ orderId: 'TG_1', paymentType: 'wxpay', now: 5_000 });
    noteExternalPaymentBackgrounded(5_000);
    expect(
      observePaymentReturn({ source: 'webview_resume', route: '/profile/orders', now: 6_000 })
    ).toBe(true);
    expect(capture.mock.calls[0]?.[0]).toMatchObject({ order_id: 'TG_1' });
  });

  it('does not invent an order id when pending state is gone', () => {
    expect(
      observePaymentReturn({
        source: 'start_param',
        orderId: null,
        route: '/profile/orders',
        now: 7_000,
      })
    ).toBe(true);
    expect(capture.mock.calls[0]?.[0]).toMatchObject({
      event: 'payment_return_observed',
      order_id: null,
      return_route: '/profile/orders',
    });
  });

  it('does not treat a reload with leftover pending storage as a return', () => {
    markExternalPaymentOpened({ orderId: 'TG_1', paymentType: 'wxpay', now: 1_000 });
    forgetPaymentReturnMemoryForTests();
    expect(
      observePaymentReturn({ source: 'webview_resume', route: '/profile/orders', now: 2_000 })
    ).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });

  it('drops query strings so pay_url never appears on return_route', () => {
    expect(
      safePaymentReturnRoute(
        'https://miniapp.local/profile/recharge/TG_1?pay_url=https://pay.example/secret&token=abc'
      )
    ).toBe('/profile/recharge/TG_1');
    expect(safePaymentReturnRoute('/profile/orders?payment=returned')).toBe('/profile/orders');
  });

  it('does not send return when replay context is gone, and can retry later', () => {
    markExternalPaymentOpened({ orderId: 'TG_1', paymentType: 'wxpay', now: 1_000 });
    getSnapshot.mockReturnValue({
      state: 'idle',
      replayContextId: null,
      telemetryReady: false,
      streaming: false,
    });
    expect(
      observePaymentReturn({
        source: 'start_param',
        orderId: 'TG_1',
        route: '/profile/recharge/TG_1',
        now: 2_000,
      })
    ).toBe(false);
    expect(capture).not.toHaveBeenCalled();

    getSnapshot.mockReturnValue({
      state: 'external_payment_pending',
      replayContextId: '11111111-1111-4111-8111-111111111111',
      telemetryReady: true,
      streaming: false,
    });
    expect(
      observePaymentReturn({
        source: 'start_param',
        orderId: 'TG_1',
        route: '/profile/recharge/TG_1',
        now: 2_100,
      })
    ).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
