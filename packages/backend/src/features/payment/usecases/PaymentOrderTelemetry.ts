/**
 * backend / features / payment / usecases / PaymentOrderTelemetry.ts
 *
 * 订单终态写入成功后的非关键观测。不得延迟或回滚结算。
 * 所有 markFailed 成功路径与 PaymentSettlement 完成路径共用这里。
 */
import {
  parseReplayTelemetryEvent,
  type PaymentSettlementSource,
  type PaymentType,
} from '@miniapp/shared';
import { findTelegramIdByUserId } from '../../../lib/user.js';
import {
  captureReplayTelemetryEvent,
  isPosthogCaptureConfigured,
  type PosthogCaptureLogger,
} from '../../../infrastructure/telemetry/posthog-capture.js';

export type PaymentTerminalTelemetryInput = {
  orderId: string;
  userId: string;
  paymentType: PaymentType;
  settledBy: PaymentSettlementSource | null;
};

export function observePaymentOrderSettled(
  input: PaymentTerminalTelemetryInput,
  log: PosthogCaptureLogger
): Promise<void> {
  return queuePaymentTerminalEvent('settled', input, log);
}

export function observePaymentOrderFailed(
  input: PaymentTerminalTelemetryInput,
  log: PosthogCaptureLogger
): Promise<void> {
  return queuePaymentTerminalEvent('failed', input, log);
}

function queuePaymentTerminalEvent(
  kind: 'settled' | 'failed',
  input: PaymentTerminalTelemetryInput,
  log: PosthogCaptureLogger
): Promise<void> {
  try {
    return emitPaymentTerminalEvent(kind, input, log).catch((err: unknown) => {
      log.sys.error(
        { event: 'payment.telemetry.failed', err, orderId: input.orderId },
        '支付终态事件发送失败'
      );
    });
  } catch (err) {
    log.sys.error(
      { event: 'payment.telemetry.failed', err, orderId: input.orderId },
      '支付终态事件发送失败'
    );
    return Promise.resolve();
  }
}

async function emitPaymentTerminalEvent(
  kind: 'settled' | 'failed',
  input: PaymentTerminalTelemetryInput,
  log: PosthogCaptureLogger
): Promise<void> {
  // 未配置时连用户反查都不做，避免测试/本地无意打到 app_core。
  if (!isPosthogCaptureConfigured()) return;

  const telegramUserId = await findTelegramIdByUserId(input.userId);
  if (!telegramUserId) {
    log.sys.warn(
      { event: 'payment.telemetry.identity_missing', orderId: input.orderId },
      '支付终态事件缺少 Telegram 用户 ID，跳过'
    );
    return;
  }

  const parsed = parseReplayTelemetryEvent({
    event: kind === 'settled' ? 'payment_order_settled' : 'payment_order_failed',
    telegram_user_id: telegramUserId,
    occurred_at: new Date().toISOString(),
    order_id: input.orderId,
    payment_type: input.paymentType,
    order_status: kind === 'settled' ? 'completed' : 'failed',
    settled_by: input.settledBy,
  });

  await captureReplayTelemetryEvent(parsed, log);
}
