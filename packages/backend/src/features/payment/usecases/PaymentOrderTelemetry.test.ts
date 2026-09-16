import { beforeEach, describe, expect, it, vi } from 'vitest';

import { observePaymentOrderFailed, observePaymentOrderSettled } from './PaymentOrderTelemetry.js';
import { findTelegramIdByUserId } from '../../../lib/user.js';
import {
  captureReplayTelemetryEvent,
  isPosthogCaptureConfigured,
} from '../../../infrastructure/telemetry/posthog-capture.js';

vi.mock('../../../lib/user.js', () => ({
  findTelegramIdByUserId: vi.fn(),
}));

vi.mock('../../../infrastructure/telemetry/posthog-capture.js', () => ({
  isPosthogCaptureConfigured: vi.fn(() => true),
  captureReplayTelemetryEvent: vi.fn(async () => 'sent'),
}));

function createLog() {
  return {
    biz: { info: vi.fn() },
    sys: { warn: vi.fn(), error: vi.fn() },
  };
}

describe('PaymentOrderTelemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPosthogCaptureConfigured).mockReturnValue(true);
    vi.mocked(findTelegramIdByUserId).mockResolvedValue('123456789');
    vi.mocked(captureReplayTelemetryEvent).mockResolvedValue('sent');
  });

  it('captures a settled event with the Telegram identity', async () => {
    await observePaymentOrderSettled(
      {
        orderId: 'MA-order-1',
        userId: '00000000-0000-0000-0000-000000000001',
        paymentType: 'wxpay',
        settledBy: 'webhook',
      },
      createLog()
    );

    await vi.waitFor(() => {
      expect(captureReplayTelemetryEvent).toHaveBeenCalledOnce();
    });

    const [event] = vi.mocked(captureReplayTelemetryEvent).mock.calls[0] ?? [];
    expect(event).toMatchObject({
      event: 'payment_order_settled',
      telegram_user_id: '123456789',
      order_id: 'MA-order-1',
      order_status: 'completed',
      settled_by: 'webhook',
    });
    expect(event).not.toHaveProperty('pay_url');
    expect(event).not.toHaveProperty('user_cohort');
  });

  it('captures a failed event from the shared observer', async () => {
    await observePaymentOrderFailed(
      {
        orderId: 'MA-order-2',
        userId: '00000000-0000-0000-0000-000000000001',
        paymentType: 'alipay',
        settledBy: null,
      },
      createLog()
    );

    await vi.waitFor(() => {
      expect(captureReplayTelemetryEvent).toHaveBeenCalledOnce();
    });

    const [event] = vi.mocked(captureReplayTelemetryEvent).mock.calls[0] ?? [];
    expect(event).toMatchObject({
      event: 'payment_order_failed',
      order_status: 'failed',
      settled_by: null,
    });
  });

  it('does not look up users or capture when PostHog is unconfigured', async () => {
    vi.mocked(isPosthogCaptureConfigured).mockReturnValue(false);

    await observePaymentOrderSettled(
      {
        orderId: 'MA-order-1',
        userId: '00000000-0000-0000-0000-000000000001',
        paymentType: 'wxpay',
        settledBy: 'cron',
      },
      createLog()
    );

    expect(findTelegramIdByUserId).not.toHaveBeenCalled();
    expect(captureReplayTelemetryEvent).not.toHaveBeenCalled();
  });
});
