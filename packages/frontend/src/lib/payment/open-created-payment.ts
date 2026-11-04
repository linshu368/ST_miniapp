'use client';

import type { CreatePaymentOrderData } from '@miniapp/shared';

import { openPaymentUrl } from '@/lib/telegram';

import { paymentOrderPagePath, persistPaymentOpen, readPaymentOpenUrl } from './open-storage';

interface PaymentRouter {
  push: (href: string) => void;
}

/**
 * 充值页和 VIP 页共用这一条外链打开和订单等待跳转。
 * 订单轮询仍在既有订单页，不在这里再做一套。
 */
export function openCreatedPayment(input: {
  router: PaymentRouter;
  result: CreatePaymentOrderData;
  returnTo: string | null;
}): void {
  const openFailureKind = persistPaymentOpen({
    orderId: input.result.order.id,
    payUrl: input.result.pay_url,
    returnTo: input.returnTo,
  });
  if (openFailureKind !== 'invalid_url') openPaymentUrl(input.result.pay_url);
  input.router.push(
    paymentOrderPagePath(input.result.order.id, {
      paymentStarted: true,
      returnTo: input.returnTo,
    })
  );
}

/** 订单页"继续支付"复用已保存的外链。 */
export function reopenStoredPayment(input: { orderId: string }): boolean {
  const payUrl = readPaymentOpenUrl(input.orderId);
  if (!payUrl) return false;
  openPaymentUrl(payUrl);
  return true;
}
