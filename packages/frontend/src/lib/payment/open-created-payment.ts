'use client';

import type { CreatePaymentOrderData, PaymentType } from '@miniapp/shared';

import { openPaymentUrl } from '@/lib/telegram';
import { getReplayLifecycle } from '@/lib/telemetry';

import { captureExternalPaymentOpenRequested, markExternalPaymentOpened } from './flow-telemetry';
import { paymentOrderPagePath, persistPaymentOpen } from './open-storage';

interface PaymentRouter {
  push: (href: string) => void;
}

/**
 * 充值页和 VIP 页共用这一条外链打开、停录和订单等待跳转。
 * 订单轮询仍在既有订单页，不在这里再做一套。
 */
export async function openCreatedPayment(input: {
  router: PaymentRouter;
  result: CreatePaymentOrderData;
  returnTo: string | null;
  paymentType: PaymentType;
}): Promise<void> {
  const openFailureKind = persistPaymentOpen({
    orderId: input.result.order.id,
    payUrl: input.result.pay_url,
    returnTo: input.returnTo,
    replayContextId: getReplayLifecycle().getSnapshot().replayContextId,
  });
  captureExternalPaymentOpenRequested({
    orderId: input.result.order.id,
    paymentType: input.paymentType,
    openFailureKind,
  });
  if (openFailureKind !== 'invalid_url') {
    await getReplayLifecycle().enterExternalPaymentPending();
    markExternalPaymentOpened({
      orderId: input.result.order.id,
      paymentType: input.paymentType,
    });
    openPaymentUrl(input.result.pay_url);
  }
  input.router.push(
    paymentOrderPagePath(input.result.order.id, {
      paymentStarted: true,
      returnTo: input.returnTo,
    })
  );
}
