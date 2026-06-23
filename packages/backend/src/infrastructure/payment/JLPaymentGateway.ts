import { createHash } from 'crypto';
import { config } from '../../platform/config.js';
import type { PaymentType } from '@miniapp/shared';

export interface CreatePaymentParams {
  type: PaymentType;
  outTradeNo: string;
  amount: string;
  userId: string;
  productName: string;
}

export interface PaymentResult {
  success: boolean;
  paymentUrl?: string;
  errorMessage?: string;
}

export interface PaymentNotifyData {
  pid?: string;
  trade_no?: string;
  out_trade_no?: string;
  type?: string;
  name?: string;
  money?: string;
  trade_status?: string;
  param?: string;
  sign?: string;
  sign_type?: string;
  [key: string]: string | undefined;
}

export class JLPaymentGateway {
  private readonly merchantId: string;
  private readonly merchantKey: string;
  private readonly baseUrl: string;
  private readonly notifyUrl: string;
  private readonly returnUrl: string;

  constructor(options?: {
    merchantId?: string;
    merchantKey?: string;
    baseUrl?: string;
    notifyUrl?: string;
    returnUrl?: string;
  }) {
    this.merchantId = options?.merchantId || config.payment.merchantId;
    this.merchantKey = options?.merchantKey || config.payment.merchantKey;
    this.baseUrl = options?.baseUrl || config.payment.baseUrl;
    this.notifyUrl = options?.notifyUrl || config.payment.notifyUrl;
    this.returnUrl = options?.returnUrl || config.payment.returnUrl;
  }

  verifyNotifySign(notifyData: PaymentNotifyData): boolean {
    if (!notifyData.sign) return false;

    const { sign, ...params } = notifyData;
    return sign === this.sign(params);
  }

  async createPayment(params: CreatePaymentParams): Promise<PaymentResult> {
    if (!this.isConfigured()) {
      return { success: false, errorMessage: '支付参数未配置' };
    }

    const paymentParams: Record<string, string | undefined> = {
      pid: this.merchantId,
      type: params.type,
      out_trade_no: params.outTradeNo,
      notify_url: this.notifyUrl,
      return_url: this.returnUrl,
      name: params.productName,
      money: params.amount,
      clientip: '127.0.0.1',
      device: 'jump',
      param: params.userId,
      sign_type: 'MD5',
    };
    paymentParams.sign = this.sign(paymentParams);

    try {
      const response = await fetch(`${this.baseUrl}/mapi.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(this.compact(paymentParams)),
        signal: AbortSignal.timeout(10_000),
      });

      const result = (await response.json()) as {
        code?: number;
        msg?: string;
        payurl?: string;
        url?: string;
      };
      const paymentUrl = result.payurl || result.url;

      if (result.code === 1 && paymentUrl) {
        return { success: true, paymentUrl };
      }

      return { success: false, errorMessage: result.msg || '创建订单失败' };
    } catch (error) {
      console.error('[payment] JLPay createPayment failed', error);
      return { success: false, errorMessage: '支付系统暂时不可用' };
    }
  }

  private isConfigured(): boolean {
    return Boolean(this.merchantId && this.merchantKey && this.notifyUrl && this.returnUrl);
  }

  private sign(params: Record<string, string | undefined>): string {
    const sortedKeys = Object.keys(params)
      .filter((key) => key !== 'sign' && key !== 'sign_type' && params[key])
      .sort();
    const signSource =
      sortedKeys.map((key) => `${key}=${params[key]}`).join('&') + this.merchantKey;
    return createHash('md5').update(signSource).digest('hex');
  }

  private compact(params: Record<string, string | undefined>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1]))
    );
  }
}
