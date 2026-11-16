import { BACKEND_ERROR_STATUS, type BackendErrorCode } from '@miniapp/shared';
import type { PaymentGatewayErrorClass } from '../../../infrastructure/payment/PaymentGateway.js';

const GATEWAY_CODES: Record<PaymentGatewayErrorClass, BackendErrorCode> = {
  configuration: 'PAYMENT_CONFIGURATION_ERROR',
  provider_rejected: 'PAYMENT_PROVIDER_REJECTED',
  method_maintenance: 'PAYMENT_PROVIDER_UNAVAILABLE',
  rate_limited: 'PAYMENT_RATE_LIMITED',
  provider_unavailable: 'PAYMENT_PROVIDER_UNAVAILABLE',
  response_invalid: 'PAYMENT_INVALID_RESPONSE',
  missing_provider_ref: 'PAYMENT_INVALID_RESPONSE',
  timeout: 'PAYMENT_TIMEOUT',
  network: 'PAYMENT_NETWORK_ERROR',
};

export class CheckoutError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: BackendErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'CheckoutError';
    this.statusCode = BACKEND_ERROR_STATUS[code];
  }
  static gateway(errorClass: PaymentGatewayErrorClass): CheckoutError {
    return new CheckoutError(
      GATEWAY_CODES[errorClass],
      errorClass === 'timeout' || errorClass === 'network'
        ? '支付结果暂未确认，请先查看订单记录'
        : '支付服务暂不可用，请稍后重试'
    );
  }
}
