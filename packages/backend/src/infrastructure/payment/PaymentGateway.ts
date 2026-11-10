import type { PaymentType } from '@miniapp/shared';

export type PaymentGatewayErrorClass =
  | 'configuration'
  | 'provider_rejected'
  | 'method_maintenance'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'response_invalid'
  | 'missing_provider_ref'
  | 'timeout'
  | 'network';

export interface CreatePaymentParams {
  orderId: string;
  amount: string;
  type: PaymentType;
  description: string;
  clientIp: string;
}

export interface PaymentResult {
  success: boolean;
  paymentUrl?: string;
  providerTransactionId?: string;
  errorMessage?: string;
  errorClass?: PaymentGatewayErrorClass;
  providerCode?: string;
  /** 请求可能已到达供应商，必须保留按商户单号查回的机会。 */
  outcomeUnknown?: boolean;
}

export interface PaymentQueryTarget {
  id: string;
  provider_transaction_id: string | null;
  payment_type: PaymentType;
}

export interface PaymentQueryResult {
  success: boolean;
  paid?: boolean;
  amount?: string;
  tradeNo?: string | null;
  status?: string;
  errorMessage?: string;
  errorClass?: PaymentGatewayErrorClass;
  providerCode?: string;
}

export interface PaymentGateway {
  createPayment(params: CreatePaymentParams): Promise<PaymentResult>;
  queryOrder(order: PaymentQueryTarget, signal?: AbortSignal): Promise<PaymentQueryResult>;
}

const USER_MESSAGES: Record<PaymentGatewayErrorClass, string> = {
  configuration: '支付暂不可用，请稍后再试',
  provider_rejected: '创建支付订单失败，请稍后重试',
  method_maintenance: '该支付方式维护中，请换一种支付方式',
  rate_limited: '支付系统繁忙，请稍后重试',
  provider_unavailable: '支付系统暂时不可用，请稍后重试',
  response_invalid: '支付平台返回异常，请稍后重试',
  missing_provider_ref: '支付订单不属于当前支付渠道',
  timeout: '支付结果暂未确认，请先查看订单记录',
  network: '支付结果暂未确认，请先查看订单记录',
};

export function paymentFailure(errorClass: PaymentGatewayErrorClass, providerCode?: string) {
  return {
    success: false as const,
    errorClass,
    errorMessage: USER_MESSAGES[errorClass],
    ...(providerCode ? { providerCode } : {}),
  };
}
