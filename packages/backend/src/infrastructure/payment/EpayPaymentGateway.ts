import { isIP } from 'node:net';
import {
  EpayCreateResponseSchema,
  EpayQueryResponseSchema,
  EpayNotificationSchema,
  type EpayNotification,
} from '@miniapp/shared';
import { config } from '../../platform/config.js';
import {
  paymentFailure,
  type CreatePaymentParams,
  type PaymentGateway,
  type PaymentQueryResult,
  type PaymentQueryTarget,
  type PaymentResult,
} from './PaymentGateway.js';
import {
  epayAmountCents,
  httpsPaymentUrl,
  isEpayOrderId,
  parseEpayQuery,
  signEpay,
  verifyEpaySignature,
} from './epay-protocol.js';
import { postEpayForm, queryEpay } from './epay-http.js';

export type EpayVerification =
  | { ok: true; event: EpayNotification }
  | {
      ok: false;
      reason: 'not_configured' | 'invalid_body' | 'signature_invalid' | 'merchant_mismatch';
    };

interface EpayOptions {
  baseUrl: string;
  appId: string;
  appKey: string;
  notifyUrl: string;
  returnUrl: string;
  environmentTag: string;
}

export class EpayPaymentGateway implements PaymentGateway {
  private readonly options: EpayOptions;

  constructor(options: Partial<EpayOptions> = {}) {
    this.options = {
      ...config.payment.epay,
      notifyUrl: config.payment.notifyUrl,
      returnUrl: config.payment.returnUrl,
      environmentTag: config.payment.environmentTag,
      ...options,
    };
  }

  get configured(): boolean {
    const { baseUrl, appId, appKey, environmentTag } = this.options;
    const url = httpsPaymentUrl(baseUrl);
    return Boolean(
      url &&
      !url.search &&
      !url.hash &&
      /^\d{1,20}$/.test(appId) &&
      appKey &&
      environmentTag &&
      environmentTag.length <= 120
    );
  }

  get environment(): string {
    return this.options.environmentTag;
  }

  async createPayment(params: CreatePaymentParams): Promise<PaymentResult> {
    const returnUrl = httpsPaymentUrl(this.options.returnUrl);
    const notifyUrl = httpsPaymentUrl(this.options.notifyUrl);
    if (
      !this.configured ||
      !returnUrl ||
      !notifyUrl ||
      !isIP(params.clientIp) ||
      !isEpayOrderId(params.orderId) ||
      !(epayAmountCents(params.amount) > 0)
    ) {
      return paymentFailure('configuration');
    }
    returnUrl.searchParams.set('order_id', params.orderId);
    const fields = {
      pid: this.options.appId,
      type: params.type,
      out_trade_no: params.orderId,
      notify_url: notifyUrl.toString(),
      return_url: returnUrl.toString(),
      name: [...params.description].slice(0, 150).join(''),
      money: params.amount,
      clientip: params.clientIp,
      device: 'mobile',
      param: this.environment,
      sign_type: 'MD5',
    };
    // 供应商未承诺建单幂等：只发一次，未知结果留给商户单号查单和通知恢复。
    const response = await postEpayForm(
      this.endpoint('mapi.php'),
      {
        ...fields,
        sign: signEpay(fields, this.options.appKey),
      },
      7_000
    );
    if (!response.success) return { ...response, outcomeUnknown: true };
    const { body } = response;
    if (body.code !== 1) return providerFailure(body.code);
    const parsed = EpayCreateResponseSchema.safeParse(body);
    const paymentUrl = parsed.success ? httpsPaymentUrl(parsed.data.payurl) : null;
    if (!parsed.success || !paymentUrl) {
      return { ...paymentFailure('response_invalid'), outcomeUnknown: true };
    }
    return {
      success: true,
      paymentUrl: paymentUrl.toString(),
      providerTransactionId: parsed.data.trade_no,
    };
  }

  async queryOrder(order: PaymentQueryTarget, signal?: AbortSignal): Promise<PaymentQueryResult> {
    if (!isEpayOrderId(order.id)) return paymentFailure('missing_provider_ref');
    if (!this.configured) return paymentFailure('configuration');
    // 商户单号是权威关联，建单响应丢失时同样可查询；按用户指定的文档 GET 协议调用。
    const response = await queryEpay(
      this.endpoint('api.php'),
      {
        act: 'order',
        pid: this.options.appId,
        key: this.options.appKey,
        out_trade_no: order.id,
      },
      5_000,
      signal
    );
    if (!response.success) return response;
    const { body } = response;
    if (body.code !== 1) return providerFailure(body.code);
    const parsed = EpayQueryResponseSchema.safeParse(body);
    if (!parsed.success) return paymentFailure('response_invalid');
    const data = parsed.data;
    if (
      data.out_trade_no !== order.id ||
      String(data.pid) !== this.options.appId ||
      data.type !== order.payment_type ||
      data.param !== this.environment ||
      (order.provider_transaction_id !== null && data.trade_no !== order.provider_transaction_id) ||
      !Number.isFinite(epayAmountCents(data.money))
    ) {
      return paymentFailure('response_invalid');
    }
    return {
      success: true,
      paid: data.status === 1,
      amount: data.money,
      tradeNo: data.trade_no,
      status: data.status === 1 ? 'completed' : 'pending',
    };
  }

  verifyNotification(rawQuery: string): EpayVerification {
    if (!this.configured) return { ok: false, reason: 'not_configured' };
    const fields = parseEpayQuery(rawQuery);
    const parsed = EpayNotificationSchema.safeParse(fields);
    if (!fields || !parsed.success) return { ok: false, reason: 'invalid_body' };
    if (!verifyEpaySignature(fields, this.options.appKey)) {
      return { ok: false, reason: 'signature_invalid' };
    }
    if (parsed.data.pid !== this.options.appId) return { ok: false, reason: 'merchant_mismatch' };
    return { ok: true, event: parsed.data };
  }

  private endpoint(file: string): string {
    return `${this.options.baseUrl.replace(/\/+$/, '')}/epay/${file}`;
  }
}

function providerFailure(code: unknown) {
  const safeCode =
    typeof code === 'number' && Number.isSafeInteger(code) ? String(code) : undefined;
  // 上游原始 msg 可能含签名、商户资料或地址，不能透传给用户或日志。
  return {
    ...paymentFailure(code === 500 ? 'provider_unavailable' : 'provider_rejected', safeCode),
    outcomeUnknown: code === 500 || safeCode === undefined,
  };
}
