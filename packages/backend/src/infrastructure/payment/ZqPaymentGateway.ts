import { createSign, createVerify } from 'crypto';
import type { PaymentType } from '@miniapp/shared';
import { config } from '../../platform/config.js';

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

export interface PaymentQueryResult {
  success: boolean;
  /** 仅 status=1（已支付）为 true。2（已退款）不算已支付。 */
  paid?: boolean;
  /** 人民币元，两位小数，用于和本地订单金额比对。 */
  amount?: string;
  tradeNo?: string | null;
  errorMessage?: string;
}

export interface ZqPaymentNotifyData {
  pid?: string;
  trade_no?: string;
  out_trade_no?: string;
  api_trade_no?: string;
  type?: string;
  trade_status?: string;
  addtime?: string;
  endtime?: string;
  name?: string;
  money?: string;
  param?: string;
  buyer?: string;
  timestamp?: string;
  sign?: string;
  sign_type?: string;
  [key: string]: string | undefined;
}

interface ZqCreateResponse {
  code?: number | string;
  msg?: string;
  trade_no?: string;
  pay_type?: string;
  pay_info?: string;
  timestamp?: string | number;
  sign?: string;
  sign_type?: string;
  [key: string]: unknown;
}

interface ZqQueryResponse {
  code?: number | string;
  msg?: string;
  status?: number | string;
  money?: string;
  trade_no?: string;
  api_trade_no?: string;
  sign?: string;
  sign_type?: string;
  [key: string]: unknown;
}

/** 厂商《订单查询》支付状态列表：0 未支付 / 1 已支付 / 2 已退款 / 3 已冻结 / 4 预授权。 */
const QUERY_STATUS_PAID = 1;

export class ZqPaymentGateway {
  private readonly baseUrl: string;
  private readonly merchantId: string;
  private readonly merchantPrivateKey: string;
  private readonly platformPublicKey: string;
  private readonly notifyUrl: string;
  private readonly returnUrl: string;

  constructor(options?: {
    baseUrl?: string;
    merchantId?: string;
    merchantPrivateKey?: string;
    platformPublicKey?: string;
    notifyUrl?: string;
    returnUrl?: string;
  }) {
    this.baseUrl = options?.baseUrl || config.payment.baseUrl;
    this.merchantId = options?.merchantId || config.payment.merchantId;
    this.merchantPrivateKey = options?.merchantPrivateKey || config.payment.merchantPrivateKey;
    this.platformPublicKey = options?.platformPublicKey || config.payment.platformPublicKey;
    this.notifyUrl = options?.notifyUrl || config.payment.notifyUrl;
    this.returnUrl = options?.returnUrl || config.payment.returnUrl;
  }

  async createPayment(params: CreatePaymentParams): Promise<PaymentResult> {
    if (!this.isConfigured()) {
      return { success: false, errorMessage: '支付参数未配置' };
    }

    const paymentParams: Record<string, string | undefined> = {
      pid: this.merchantId,
      method: 'jump',
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
    paymentParams.sign = this.sign(paymentParams);

    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/api/pay/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(compact(paymentParams)),
        signal: AbortSignal.timeout(10_000),
      });
      const result = (await response.json()) as ZqCreateResponse;

      if (Number(result.code) !== 0) {
        return { success: false, errorMessage: result.msg || '创建支付订单失败' };
      }
      if (result.sign && !this.verifySign(result, result.sign)) {
        return { success: false, errorMessage: '支付平台响应验签失败' };
      }
      if (result.pay_type?.toLowerCase() !== 'jump') {
        return {
          success: false,
          errorMessage: `支付平台未返回跳转支付地址（${result.pay_type || 'unknown'}）`,
        };
      }

      const paymentUrl = typeof result.pay_info === 'string' ? result.pay_info.trim() : '';
      if (!isSafePaymentUrl(paymentUrl)) {
        return { success: false, errorMessage: '支付平台返回了无效跳转地址' };
      }

      return { success: true, paymentUrl };
    } catch (error) {
      console.error('[payment] ZqPay createPayment failed', error);
      return { success: false, errorMessage: '支付系统暂时不可用' };
    }
  }

  /** 主动查单。厂商的异步通知不保证送达，查单是唯一由我们发起、不依赖对方推送的口径。
   *  文档：POST {baseUrl}/api/pay/query */
  async queryOrder(outTradeNo: string): Promise<PaymentQueryResult> {
    if (!this.isConfigured()) {
      return { success: false, errorMessage: '支付参数未配置' };
    }

    const queryParams: Record<string, string | undefined> = {
      pid: this.merchantId,
      out_trade_no: outTradeNo,
      timestamp: Math.floor(Date.now() / 1000).toString(),
      sign_type: 'RSA',
    };
    queryParams.sign = this.sign(queryParams);

    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/api/pay/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(compact(queryParams)),
        signal: AbortSignal.timeout(8_000),
      });
      const result = (await response.json()) as ZqQueryResponse;

      if (Number(result.code) !== 0) {
        return { success: false, errorMessage: result.msg || '查询支付订单失败' };
      }
      if (result.sign && !this.verifySign(result, result.sign)) {
        return { success: false, errorMessage: '支付平台响应验签失败' };
      }

      return {
        success: true,
        paid: Number(result.status) === QUERY_STATUS_PAID,
        amount: typeof result.money === 'string' ? result.money : undefined,
        tradeNo: result.trade_no ?? null,
      };
    } catch (error) {
      console.error('[payment] ZqPay queryOrder failed', error);
      return { success: false, errorMessage: '支付系统暂时不可用' };
    }
  }

  /** 安全边界是「平台公钥能验通这个签名」，不是「sign_type 字面量等于 RSA」。
   *  子千易实测会省略响应里的 sign_type（见 0ce6eb2），异步通知同样可能不带，
   *  所以缺失时按 RSA 验；带了但不是 RSA 时仍然拒绝，避免被降级到弱算法。 */
  verifyNotifySign(notifyData: ZqPaymentNotifyData): boolean {
    if (!notifyData.sign) return false;
    if (notifyData.sign_type && notifyData.sign_type.toUpperCase() !== 'RSA') return false;
    return this.verifySign(notifyData, notifyData.sign);
  }

  isExpectedMerchant(pid: string | undefined): boolean {
    return Boolean(pid && pid === this.merchantId);
  }

  private isConfigured(): boolean {
    return Boolean(
      this.baseUrl &&
      this.merchantId &&
      this.merchantPrivateKey &&
      this.platformPublicKey &&
      this.notifyUrl &&
      this.returnUrl
    );
  }

  private sign(params: Record<string, unknown>): string {
    const signer = createSign('RSA-SHA256');
    signer.update(signingSource(params));
    signer.end();
    return signer.sign(normalizePem(this.merchantPrivateKey, 'PRIVATE KEY'), 'base64');
  }

  private verifySign(params: Record<string, unknown>, signature: string): boolean {
    try {
      const verifier = createVerify('RSA-SHA256');
      verifier.update(signingSource(params));
      verifier.end();
      return verifier.verify(
        normalizePem(this.platformPublicKey, 'PUBLIC KEY'),
        signature.replace(/ /g, '+'),
        'base64'
      );
    } catch {
      return false;
    }
  }
}

function signingSource(params: Record<string, unknown>): string {
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

function compact(params: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
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

function isSafePaymentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
