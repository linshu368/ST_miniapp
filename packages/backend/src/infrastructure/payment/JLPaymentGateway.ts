import { createHash, createSign, createVerify } from 'crypto';
import { config } from '../../platform/config.js';
import type { PaymentType } from '@miniapp/shared';

export interface CreatePaymentParams {
  type: PaymentType;
  outTradeNo: string;
  amount: string;
  userId: string;
  productName: string;
  clientIp: string;
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
  private readonly v2BaseUrl: string;
  private readonly merchantPrivateKey: string;
  private readonly platformPublicKey: string;
  private readonly notifyUrl: string;
  private readonly returnUrl: string;

  constructor(options?: {
    merchantId?: string;
    merchantKey?: string;
    baseUrl?: string;
    v2BaseUrl?: string;
    merchantPrivateKey?: string;
    platformPublicKey?: string;
    notifyUrl?: string;
    returnUrl?: string;
  }) {
    this.merchantId = options?.merchantId || config.payment.merchantId;
    this.merchantKey = options?.merchantKey || config.payment.merchantKey;
    this.baseUrl = options?.baseUrl || config.payment.baseUrl;
    this.v2BaseUrl = options?.v2BaseUrl || config.payment.v2BaseUrl;
    this.merchantPrivateKey = options?.merchantPrivateKey || config.payment.merchantPrivateKey;
    this.platformPublicKey = options?.platformPublicKey || config.payment.platformPublicKey;
    this.notifyUrl = options?.notifyUrl || config.payment.notifyUrl;
    this.returnUrl = options?.returnUrl || config.payment.returnUrl;
  }

  verifyNotifySign(notifyData: PaymentNotifyData): boolean {
    if (!notifyData.sign) return false;

    const { sign, ...params } = notifyData;
    if (notifyData.sign_type?.toUpperCase() === 'RSA' && this.platformPublicKey) {
      return this.verifyRsa(params, sign);
    }
    if (!this.merchantKey) return false;
    return sign === this.sign(params);
  }

  async createPayment(params: CreatePaymentParams): Promise<PaymentResult> {
    if (!this.isConfigured()) {
      return { success: false, errorMessage: '支付参数未配置' };
    }

    if (this.canUseV2()) {
      return this.createV2Payment(params);
    }

    return this.createLegacyPayment(params);
  }

  private async createV2Payment(params: CreatePaymentParams): Promise<PaymentResult> {
    const paymentParams: Record<string, string | undefined> = {
      pid: this.merchantId,
      method: 'web',
      device: 'mobile',
      type: params.type,
      out_trade_no: params.outTradeNo,
      notify_url: this.notifyUrl,
      return_url: this.returnUrl,
      name: params.productName,
      money: params.amount,
      clientip: params.clientIp,
      param: params.userId,
      timestamp: Math.floor(Date.now() / 1000).toString(),
      sign_type: 'RSA',
    };
    paymentParams.sign = this.signRsa(paymentParams);

    try {
      const response = await fetch(`${this.v2BaseUrl.replace(/\/+$/, '')}/api/pay/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(this.compact(paymentParams)),
        signal: AbortSignal.timeout(10_000),
      });
      const result = (await response.json()) as {
        code?: number;
        msg?: string;
        trade_no?: string;
        pay_type?: string;
        pay_info?: string;
        timestamp?: string | number;
        sign?: string;
        sign_type?: string;
        [key: string]: unknown;
      };

      if (result.code !== 0) {
        return { success: false, errorMessage: result.msg || '创建订单失败' };
      }
      if (!result.sign || !this.verifyRsa(result, result.sign)) {
        return { success: false, errorMessage: '支付平台响应验签失败' };
      }

      const payType = result.pay_type?.toLowerCase();
      const paymentUrl = typeof result.pay_info === 'string' ? result.pay_info.trim() : '';
      if (
        (payType === 'scheme' && /^weixin:\/\//i.test(paymentUrl)) ||
        (payType === 'jump' && /^https?:\/\//i.test(paymentUrl))
      ) {
        return { success: true, paymentUrl };
      }

      return {
        success: false,
        errorMessage: `支付通道未返回微信直达链接（${payType || 'unknown'}）`,
      };
    } catch (error) {
      console.error('[payment] JLPay V2 createPayment failed', error);
      return { success: false, errorMessage: '支付系统暂时不可用' };
    }
  }

  private async createLegacyPayment(params: CreatePaymentParams): Promise<PaymentResult> {
    const paymentParams: Record<string, string | undefined> = {
      pid: this.merchantId,
      type: params.type,
      out_trade_no: params.outTradeNo,
      notify_url: this.notifyUrl,
      return_url: this.returnUrl,
      name: params.productName,
      money: params.amount,
      clientip: params.clientIp,
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
    return Boolean(
      this.merchantId && this.notifyUrl && this.returnUrl && (this.canUseV2() || this.merchantKey)
    );
  }

  private canUseV2(): boolean {
    return Boolean(this.v2BaseUrl && this.merchantPrivateKey && this.platformPublicKey);
  }

  private sign(params: Record<string, string | undefined>): string {
    const sortedKeys = Object.keys(params)
      .filter((key) => key !== 'sign' && key !== 'sign_type' && params[key])
      .sort();
    const signSource =
      sortedKeys.map((key) => `${key}=${params[key]}`).join('&') + this.merchantKey;
    return createHash('md5').update(signSource).digest('hex');
  }

  private signRsa(params: Record<string, unknown>): string {
    const signer = createSign('RSA-SHA256');
    signer.update(this.signingSource(params));
    signer.end();
    return signer.sign(normalizePem(this.merchantPrivateKey, 'PRIVATE KEY'), 'base64');
  }

  private verifyRsa(params: Record<string, unknown>, signature: string): boolean {
    try {
      const verifier = createVerify('RSA-SHA256');
      verifier.update(this.signingSource(params));
      verifier.end();
      return verifier.verify(
        normalizePem(this.platformPublicKey, 'PUBLIC KEY'),
        signature,
        'base64'
      );
    } catch {
      return false;
    }
  }

  private signingSource(params: Record<string, unknown>): string {
    return Object.keys(params)
      .filter(
        (key) =>
          key !== 'sign' &&
          key !== 'sign_type' &&
          params[key] !== undefined &&
          params[key] !== null &&
          params[key] !== ''
      )
      .sort()
      .map((key) => `${key}=${String(params[key])}`)
      .join('&');
  }

  private compact(params: Record<string, string | undefined>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1]))
    );
  }
}

function normalizePem(value: string, label: 'PRIVATE KEY' | 'PUBLIC KEY'): string {
  const normalized = value.replace(/\\n/g, '\n').trim();
  if (normalized.includes('-----BEGIN')) return normalized;
  const body =
    normalized
      .replace(/\s+/g, '')
      .match(/.{1,64}/g)
      ?.join('\n') ?? normalized;
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}
