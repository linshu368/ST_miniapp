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
  /** 可直接唤起支付宝 App 的 scheme，解析失败时缺省 */
  paymentScheme?: string;
  errorMessage?: string;
}

/** 收银台页名首字母即支付方式，a=支付宝 w=微信 */
const CASHIER_ORDER_PATTERN = /([wzamy])(\d{18,20})\.html/i;
/**
 * 收银台给的「收款码」其实是厂商一个明文 HTTP 裸 IP 中转页，它再自动提交
 * alipay.trade.wap.pay 表单跳到支付宝官方收银台。走扫一扫处理器（saId=10000007）
 * 会被当成扫到的码去校验，这种地址过不了校验，端上表现为「无法加载」；
 * 改用 H5 容器（appId=20000067）让支付宝内置浏览器直接打开中转页，
 * 后面的跳转由支付宝自己完成，和真机浏览器里的流程一致。
 */
const ALIPAY_H5_WRAPPER = 'alipays://platformapi/startapp?appId=20000067&url=';
const SCHEME_RESOLVE_BUDGET_MS = 6_000;
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

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
  private readonly alipaySchemeEnabled: boolean;

  constructor(options?: {
    alipaySchemeEnabled?: boolean;
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
    this.alipaySchemeEnabled = options?.alipaySchemeEnabled ?? config.payment.alipaySchemeEnabled;
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
      console.info(
        {
          payType: payType || 'unknown',
          paymentTarget: describePaymentTarget(paymentUrl),
        },
        '[payment] JLPay V2 create response'
      );

      if (payType === 'scheme' && /^weixin:\/\//i.test(paymentUrl)) {
        return { success: true, paymentUrl };
      }

      return {
        success: false,
        errorMessage: `支付厂商未返回微信直达 scheme（${payType || 'unknown'}）`,
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
        const paymentScheme =
          params.type === 'alipay' && this.alipaySchemeEnabled
            ? await this.resolveAlipayScheme(paymentUrl)
            : undefined;
        return { success: true, paymentUrl, paymentScheme };
      }

      return { success: false, errorMessage: result.msg || '创建订单失败' };
    } catch (error) {
      console.error('[payment] JLPay createPayment failed', error);
      return { success: false, errorMessage: '支付系统暂时不可用' };
    }
  }

  /**
   * 厂商下单只给出一个中转页，真正的收款码要再经过「自动提交表单 → 上游 302 → 收银台轮询」
   * 三跳才拿得到。这里复刻收银台前端的做法把链路走完，再把收款码套成支付宝唤起协议，
   * 让 MiniApp 一步拉起支付宝而不是停在扫码页。整条链路是厂商实现细节，随时可能变，
   * 因此任何一步失败都只记日志并返回 undefined，调用方继续用原始跳转页。
   */
  private async resolveAlipayScheme(payUrl: string): Promise<string | undefined> {
    const startedAt = Date.now();
    const deadline = startedAt + SCHEME_RESOLVE_BUDGET_MS;
    const nextSignal = (): AbortSignal => {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('resolve budget exhausted');
      return AbortSignal.timeout(left);
    };

    try {
      const bridge = await fetch(payUrl, {
        headers: { 'User-Agent': MOBILE_UA },
        signal: nextSignal(),
      });
      const form = parseAutoSubmitForm(await bridge.text());
      if (!form) return undefined;

      const forwarded = await fetch(form.action, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'User-Agent': MOBILE_UA,
          Referer: payUrl,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(form.fields),
        signal: nextSignal(),
      });
      const cashierUrl = forwarded.headers.get('location');
      if (!cashierUrl) return undefined;

      const [, mode, cashierOrderId] = CASHIER_ORDER_PATTERN.exec(cashierUrl) ?? [];
      if (!cashierOrderId || mode?.toLowerCase() !== 'a') return undefined;

      const polled = await fetch(
        new URL(`/cas/order/polling?orderId=${cashierOrderId}`, cashierUrl),
        {
          headers: { 'User-Agent': MOBILE_UA, Referer: cashierUrl },
          signal: nextSignal(),
        }
      );
      const data = (await polled.json()) as { qrcode?: string; urlScheme?: string };
      const target = data.urlScheme?.trim() || data.qrcode?.trim();
      if (!target) return undefined;

      const scheme = target.toLowerCase().startsWith('alipays://')
        ? target
        : `${ALIPAY_H5_WRAPPER}${encodeURIComponent(target)}`;
      console.info(
        { elapsedMs: Date.now() - startedAt, target: describePaymentTarget(target) },
        '[payment] resolved alipay scheme'
      );
      return scheme;
    } catch (error) {
      console.warn(
        { reason: error instanceof Error ? error.message : 'unknown' },
        '[payment] resolve alipay scheme failed, falling back to h5'
      );
      return undefined;
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

function parseAutoSubmitForm(
  html: string
): { action: string; fields: Record<string, string> } | null {
  const action = /<form[^>]+action="([^"]+)"/i.exec(html)?.[1];
  if (!action) return null;

  const fields: Record<string, string> = {};
  for (const [, name, value] of html.matchAll(/<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"/gi)) {
    if (!name) continue;
    fields[decodeHtmlEntities(name)] = decodeHtmlEntities(value ?? '');
  }
  return Object.keys(fields).length ? { action: decodeHtmlEntities(action), fields } : null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function describePaymentTarget(value: string): string {
  if (/^weixin:\/\//i.test(value)) return 'weixin://';
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return value ? 'invalid' : 'empty';
  }
}
