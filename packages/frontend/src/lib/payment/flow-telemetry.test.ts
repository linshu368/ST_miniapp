import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentOrder } from '@miniapp/shared';

import {
  capturePaymentOrderStatusObserved,
  resetPaymentFlowTelemetryForTests,
} from './flow-telemetry';

const capture = vi.fn();
const getSnapshot = vi.fn(() => ({
  state: 'paywall_followup' as const,
  replayContextId: '11111111-1111-4111-8111-111111111111',
  telemetryReady: true,
  streaming: false,
}));

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

beforeEach(() => {
  capture.mockClear();
  resetPaymentFlowTelemetryForTests();
});

afterEach(() => {
  resetPaymentFlowTelemetryForTests();
});

describe('payment flow telemetry', () => {
  it('records order status once per order_id + state + settled_by', () => {
    capturePaymentOrderStatusObserved(order);
    capturePaymentOrderStatusObserved(order);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(capture.mock.calls[0])).not.toContain('pay_url');

    capturePaymentOrderStatusObserved({ ...order, status: 'completed', settled_by: 'return' });
    expect(capture).toHaveBeenCalledTimes(2);
  });
});
