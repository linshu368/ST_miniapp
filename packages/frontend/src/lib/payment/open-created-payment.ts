'use client';

import type {
  CreatePaymentOrderData,
  PaymentType,
  PostCheckoutConfirmationRequest,
} from '@miniapp/shared';

import { openPaymentUrl } from '@/lib/telegram';
import { getReplayLifecycle } from '@/lib/telemetry';

import { captureExternalPaymentOpenRequested, markExternalPaymentOpened } from './flow-telemetry';
import {
  createCheckoutConfirmation,
  paymentOrderPagePath,
  persistPaymentOpen,
  prepareReopenCheckoutConfirmation,
  readPaymentOpenUrl,
} from './open-storage';

interface PaymentRouter {
  push: (href: string) => void;
}

export type CheckoutConfirmationReporter = (input: {
  orderId: string;
  request: PostCheckoutConfirmationRequest;
}) => void;

/**
 * 充值页和 VIP 页共用这一条外链打开、停录和订单等待跳转。
 * 订单轮询仍在既有订单页，不在这里再做一套。
 */
export async function openCreatedPayment(input: {
  router: PaymentRouter;
  result: CreatePaymentOrderData;
  returnTo: string | null;
  paymentType: PaymentType;
  reportCheckoutConfirmation: CheckoutConfirmationReporter;
}): Promise<void> {
  const confirmation = createCheckoutConfirmation('initial_open');
  const openFailureKind = persistPaymentOpen({
    orderId: input.result.order.id,
    payUrl: input.result.pay_url,
    returnTo: input.returnTo,
    replayContextId: getReplayLifecycle().getSnapshot().replayContextId,
    checkoutConfirmation: confirmation,
  });
  captureExternalPaymentOpenRequested({
    orderId: input.result.order.id,
    paymentType: input.paymentType,
    openFailureKind,
  });
  if (openFailureKind !== 'invalid_url') {
    if (confirmation) {
      // Mutation starts synchronously; never make checkout availability depend on its outcome.
      input.reportCheckoutConfirmation({ orderId: input.result.order.id, request: confirmation });
    }
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

/** The order page shares the same pre-open ordering and only differs in the action label. */
export async function reopenStoredPayment(input: {
  orderId: string;
  paymentType: PaymentType;
  reportCheckoutConfirmation: CheckoutConfirmationReporter;
}): Promise<boolean> {
  const payUrl = readPaymentOpenUrl(input.orderId);
  if (!payUrl) return false;
  const confirmation = prepareReopenCheckoutConfirmation(input.orderId);
  if (confirmation) {
    input.reportCheckoutConfirmation({ orderId: input.orderId, request: confirmation });
  }
  captureExternalPaymentOpenRequested({ orderId: input.orderId, paymentType: input.paymentType });
  await getReplayLifecycle().enterExternalPaymentPending();
  markExternalPaymentOpened({ orderId: input.orderId, paymentType: input.paymentType });
  openPaymentUrl(payUrl);
  return true;
}
