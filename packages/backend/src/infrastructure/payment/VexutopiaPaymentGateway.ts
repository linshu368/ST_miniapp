import { createHmac, timingSafeEqual } from 'crypto';
import type { PaymentType } from '@miniapp/shared';
import { config } from '../../platform/config.js';

export interface CreatePaymentParams {
  orderId: string;
  /** 人民币元，两位小数。 */
  amount: string;
  type: PaymentType;
  /** 收银台展示用商品名，由服务端商品快照决定。 */
  description: string;
}

export interface PaymentResult {
  success: boolean;
  paymentUrl?: string;
  providerTransactionId?: string;
  errorMessage?: string;
  /** Stable monitoring value; never derive rules from provider prose. */
  errorClass?: PaymentGatewayErrorClass;
  /** 供应商机器错误码，只用于日志定位。 */
  providerCode?: string;
}

export interface PaymentQueryResult {
  success: boolean;
  /** 仅 status=completed 且币种为 CNY 时为 true；退款、取消、过期都不算已支付。 */
  paid?: boolean;
  /** 人民币元字符串，用于和本地订单金额比对。 */
  amount?: string;
  tradeNo?: string | null;
  status?: string;
  errorMessage?: string;
  errorClass?: PaymentGatewayErrorClass;
  providerCode?: string;
}

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

export interface PaymentQueryTarget {
  id: string;
  provider_transaction_id: string | null;
}

/** 用例与对账任务只依赖这两个能力，测试可以直接给替身。 */
export interface PaymentGateway {
  createPayment(params: CreatePaymentParams): Promise<PaymentResult>;
  queryOrder(order: PaymentQueryTarget): Promise<PaymentQueryResult>;
}

export interface PaymentLookupItem {
  transactionId: string;
  found: boolean;
  /** 小写平台状态：pending / completed / failed / expired / cancelled / refunded / partially_refunded。 */
  status?: string;
  amount?: string;
  currency?: string;
  /** metadata 回显的本地订单号；平台没回显时为 undefined。 */
  orderId?: string;
}

export type PaymentLookupResult =
  | { success: true; items: PaymentLookupItem[] }
  | {
      success: false;
      errorClass: PaymentGatewayErrorClass;
      errorMessage: string;
      providerCode?: string;
    };

export interface PaymentLookupGateway {
  lookupPayments(transactionIds: string[]): Promise<PaymentLookupResult>;
}

/** 批量查单单次上限（平台限制）。 */
export const LOOKUP_BATCH_SIZE = 100;

export interface VexutopiaWebhookEvent {
  event: string;
  /** 区域通道可能是子交易 id；入账以 payment_id（根会话）为准。 */
  id?: string;
  payment_id?: string;
  status?: string;
  amount?: string;
  currency?: string;
  payment_method?: string;
  /** payment.refunded 时为 refund / chargeback。 */
  type?: string;
  livemode?: boolean;
  metadata?: Record<string, string>;
}

export type WebhookVerification =
  | { ok: true; event: VexutopiaWebhookEvent }
  | {
      ok: false;
      reason: 'not_configured' | 'signature_invalid' | 'stale_timestamp' | 'invalid_body';
    };

export interface VexutopiaWebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  mode: string;
  is_enabled?: boolean;
  created_at?: string;
}

interface VexutopiaPaymentResponse {
  id?: unknown;
  status?: unknown;
  checkout_url?: unknown;
  amount?: unknown;
  currency?: unknown;
  metadata?: unknown;
}

type RequestOutcome =
  | { ok: true; body: unknown }
  | {
      ok: false;
      errorClass: PaymentGatewayErrorClass;
      providerCode?: string;
      retryAfterMs?: number;
    };

const CREATE_TIMEOUT_MS = 7_000;
const QUERY_TIMEOUT_MS = 5_000;
const LOOKUP_TIMEOUT_MS = 8_000;
const ADMIN_TIMEOUT_MS = 10_000;
const CREATE_MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;
const MAX_RETRY_AFTER_MS = 2_000;
const SIGNATURE_TOLERANCE_SECONDS = 300;
const USER_AGENT = 'MIJINGAI-Backend/1.0';
const TRANSACTION_ID_PATTERN = /^tx_[A-Za-z0-9]{1,120}$/;
/**
 * 平台保留部分 metadata 键并在读回时隐藏（实测 `channel` 未回显），通用键名可能被吞。
 * 用带前缀的键，Webhook 和查单都按它关联本地订单与环境。
 */
export const METADATA_ORDER_ID = 'mijing_order_id';
export const METADATA_ENVIRONMENT = 'mijing_env';

const PAYMENT_METHODS: Record<PaymentType, 'ALIPAY' | 'WXPAY'> = {
  alipay: 'ALIPAY',
  wxpay: 'WXPAY',
};

/** 面向用户的提示只按分类给，不透传供应商英文原文。 */
const USER_MESSAGES: Record<PaymentGatewayErrorClass, string> = {
  configuration: '支付暂不可用，请稍后再试',
  provider_rejected: '创建支付订单失败，请稍后重试',
  method_maintenance: '该支付方式维护中，请换一种支付方式',
  rate_limited: '支付系统繁忙，请稍后重试',
  provider_unavailable: '支付系统暂时不可用，请稍后重试',
  response_invalid: '支付平台返回异常，请稍后重试',
  missing_provider_ref: '支付订单缺少平台单号',
  timeout: '支付系统响应超时，请稍后重试',
  network: '支付系统暂时不可用，请稍后重试',
};

export class VexutopiaPaymentGateway implements PaymentGateway, PaymentLookupGateway {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly webhookSecret: string;
  private readonly returnUrl: string;
  private readonly environmentTag: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options?: {
    baseUrl?: string;
    apiKey?: string;
    webhookSecret?: string;
    returnUrl?: string;
    environmentTag?: string;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.baseUrl = (options?.baseUrl ?? config.payment.vexutopia.baseUrl).replace(/\/+$/, '');
    this.apiKey = options?.apiKey ?? config.payment.vexutopia.apiKey;
    this.webhookSecret = options?.webhookSecret ?? config.payment.vexutopia.webhookSecret;
    this.returnUrl = options?.returnUrl ?? config.payment.returnUrl;
    this.environmentTag = options?.environmentTag ?? config.payment.environmentTag;
    this.sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get environment(): string {
    return this.environmentTag;
  }

  async createPayment(params: CreatePaymentParams): Promise<PaymentResult> {
    const returnUrl = parseHttpsUrl(this.returnUrl);
    if (!this.apiKey || !this.baseUrl || !returnUrl) {
      return failure('configuration');
    }
    returnUrl.searchParams.set('order_id', params.orderId);
    const body = JSON.stringify({
      amount: params.amount,
      currency: 'CNY',
      payment_method: PAYMENT_METHODS[params.type],
      country: 'CN',
      locale: 'zh-CN',
      return_url: returnUrl.toString(),
      description: params.description.slice(0, 120),
      metadata: {
        [METADATA_ORDER_ID]: params.orderId,
        [METADATA_ENVIRONMENT]: this.environmentTag,
      },
    });
    // 同一本地订单永远用同一个幂等键，保证一单最多在平台建一笔交易。注意：2026-11-03 实测同键同 body
    // 重放返回 409 IDEMPOTENCY_KEY_REUSED（文档写会返回原结果）。所以首次其实已建单、我们却超时时，
    // 重试会以 provider_rejected 失败，用户重新下单即可；那笔未付交易 30 分钟后自行过期，不会重复扣款。
    const headers = { 'Idempotency-Key': `order-${params.orderId}` };

    let outcome: RequestOutcome = { ok: false, errorClass: 'network' };
    for (let attempt = 1; attempt <= CREATE_MAX_ATTEMPTS; attempt += 1) {
      outcome = await this.request('POST', '/payments', CREATE_TIMEOUT_MS, body, headers);
      if (outcome.ok || attempt === CREATE_MAX_ATTEMPTS || !isRetryable(outcome)) break;
      await this.sleep(
        outcome.errorClass === 'rate_limited'
          ? Math.min(outcome.retryAfterMs ?? RETRY_DELAY_MS, MAX_RETRY_AFTER_MS)
          : RETRY_DELAY_MS
      );
    }

    if (!outcome.ok) return failure(outcome.errorClass, outcome.providerCode);

    const payment = asObject(outcome.body) as VexutopiaPaymentResponse;
    const transactionId = typeof payment.id === 'string' ? payment.id : '';
    const checkoutUrl = typeof payment.checkout_url === 'string' ? payment.checkout_url.trim() : '';
    if (!TRANSACTION_ID_PATTERN.test(transactionId) || !isHttpsUrl(checkoutUrl)) {
      return failure('response_invalid');
    }
    return { success: true, paymentUrl: checkoutUrl, providerTransactionId: transactionId };
  }

  /** 主动查单。Webhook 不保证送达，查单是唯一由我们发起、不依赖对方推送的口径。 */
  async queryOrder(order: PaymentQueryTarget): Promise<PaymentQueryResult> {
    const transactionId = order.provider_transaction_id;
    if (!transactionId || !TRANSACTION_ID_PATTERN.test(transactionId)) {
      return failure('missing_provider_ref');
    }
    if (!this.apiKey || !this.baseUrl) return failure('configuration');

    const outcome = await this.request(
      'GET',
      `/payments/${encodeURIComponent(transactionId)}`,
      QUERY_TIMEOUT_MS
    );
    if (!outcome.ok) return failure(outcome.errorClass, outcome.providerCode);

    const payment = asObject(outcome.body) as VexutopiaPaymentResponse;
    const status = typeof payment.status === 'string' ? payment.status.toLowerCase() : '';
    const metadataOrderId = asStringRecord(payment.metadata)?.[METADATA_ORDER_ID];
    // 交易号来自我们自己建单时落库的值，已足以关联；metadata 只做纵深校验：
    // 带了但对不上，说明交易号写串了，宁可不入账。
    if (
      payment.id !== transactionId ||
      !status ||
      (metadataOrderId !== undefined && metadataOrderId !== order.id)
    ) {
      return failure('response_invalid');
    }

    const amount = typeof payment.amount === 'string' ? payment.amount : undefined;
    if (status === 'completed' && payment.currency !== 'CNY') {
      return failure('response_invalid');
    }
    return {
      success: true,
      paid: status === 'completed',
      status,
      amount,
      tradeNo: transactionId,
    };
  }

  /** 对账任务用：一次请求拿回整批订单的平台真实状态，替代逐单查单。 */
  async lookupPayments(transactionIds: string[]): Promise<PaymentLookupResult> {
    if (transactionIds.length === 0) return { success: true, items: [] };
    if (transactionIds.length > LOOKUP_BATCH_SIZE) {
      throw new Error(`lookupPayments 单次最多 ${LOOKUP_BATCH_SIZE} 个交易号`);
    }
    if (!this.apiKey || !this.baseUrl) return failure('configuration');

    const outcome = await this.request(
      'POST',
      '/payments/lookup',
      LOOKUP_TIMEOUT_MS,
      JSON.stringify({ payment_ids: transactionIds })
    );
    if (!outcome.ok) return failure(outcome.errorClass, outcome.providerCode);

    const results = asObject(outcome.body).results;
    if (!Array.isArray(results)) return failure('response_invalid');
    const requested = new Set(transactionIds);
    const items: PaymentLookupItem[] = [];
    for (const raw of results) {
      const result = asObject(raw);
      if (typeof result.id !== 'string' || !requested.has(result.id)) continue;
      items.push({
        transactionId: result.id,
        found: result.found === true,
        status: typeof result.status === 'string' ? result.status.toLowerCase() : undefined,
        amount: typeof result.amount === 'string' ? result.amount : undefined,
        currency: typeof result.currency === 'string' ? result.currency : undefined,
        orderId: asStringRecord(result.metadata)?.[METADATA_ORDER_ID],
      });
    }
    return { success: true, items };
  }

  /**
   * 签名串是 `{t}.{原始 body}`，必须用未经解析的原始字节；重新序列化的 JSON 会验不过。
   * 允许头里出现多个 v1（供应商轮换 secret 时的常见做法），任一匹配即通过。
   */
  verifyWebhook(
    rawBody: Buffer,
    signatureHeader: string | undefined,
    nowMs = Date.now()
  ): WebhookVerification {
    if (!this.webhookSecret) return { ok: false, reason: 'not_configured' };
    if (!signatureHeader) return { ok: false, reason: 'signature_invalid' };

    let timestamp = '';
    const signatures: string[] = [];
    for (const part of signatureHeader.split(',')) {
      const separator = part.indexOf('=');
      if (separator <= 0) continue;
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (key === 't') timestamp = value;
      else if (key === 'v1') signatures.push(value);
    }
    if (!/^\d{1,12}$/.test(timestamp) || signatures.length === 0) {
      return { ok: false, reason: 'signature_invalid' };
    }

    const expected = createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const matched = signatures.some((signature) => {
      const candidate = Buffer.from(signature, 'utf8');
      return (
        candidate.length === expectedBuffer.length && timingSafeEqual(candidate, expectedBuffer)
      );
    });
    if (!matched) return { ok: false, reason: 'signature_invalid' };

    // 先验签再看时间：未签名的请求不该影响 stale 统计。
    if (Math.abs(nowMs / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) {
      return { ok: false, reason: 'stale_timestamp' };
    }

    try {
      const parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
      const event = asObject(parsed) as Partial<VexutopiaWebhookEvent>;
      if (typeof event.event !== 'string') return { ok: false, reason: 'invalid_body' };
      return {
        ok: true,
        event: {
          ...event,
          event: event.event,
          metadata: asStringRecord(event.metadata),
        },
      };
    } catch {
      return { ok: false, reason: 'invalid_body' };
    }
  }

  async listWebhooks(): Promise<VexutopiaWebhookEndpoint[]> {
    const outcome = await this.request('GET', '/webhooks', ADMIN_TIMEOUT_MS);
    if (!outcome.ok) throw adminError('列出 Webhook 端点', outcome);
    const data = asObject(outcome.body).data;
    return Array.isArray(data) ? (data as VexutopiaWebhookEndpoint[]) : [];
  }

  /** secret 只在创建时返回一次，调用方负责立刻交给操作者，不得写日志。 */
  async registerWebhook(
    url: string,
    events: string[]
  ): Promise<VexutopiaWebhookEndpoint & { secret: string }> {
    const outcome = await this.request(
      'POST',
      '/webhooks',
      ADMIN_TIMEOUT_MS,
      JSON.stringify({ url, events, mode: 'live' })
    );
    if (!outcome.ok) throw adminError('注册 Webhook 端点', outcome);
    const endpoint = asObject(outcome.body) as Partial<
      VexutopiaWebhookEndpoint & { secret: string }
    >;
    if (typeof endpoint.id !== 'string' || typeof endpoint.secret !== 'string') {
      throw new Error('注册 Webhook 端点失败：响应缺少 id 或 secret');
    }
    return endpoint as VexutopiaWebhookEndpoint & { secret: string };
  }

  async deleteWebhook(id: string): Promise<void> {
    const outcome = await this.request(
      'DELETE',
      `/webhooks/${encodeURIComponent(id)}`,
      ADMIN_TIMEOUT_MS
    );
    if (!outcome.ok) throw adminError('删除 Webhook 端点', outcome);
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    timeoutMs: number,
    body?: string,
    extraHeaders: Record<string, string> = {}
  ): Promise<RequestOutcome> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'X-API-Key': this.apiKey,
          Accept: 'application/json',
          // 官方建议带可识别的 UA，通用自动化 UA 可能被边缘防护拦截。
          'User-Agent': USER_AGENT,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...extraHeaders,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return {
        ok: false,
        errorClass:
          error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'network',
      };
    }

    if (response.status === 204) return { ok: true, body: {} };

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      // 2xx 却不是 JSON 是协议异常；非 2xx 的 HTML 错误页按状态码分类即可。
      if (response.ok) return { ok: false, errorClass: 'response_invalid' };
      parsed = {};
    }

    if (response.ok) return { ok: true, body: parsed };

    const code = asObject(parsed).code;
    const providerCode = typeof code === 'string' ? code : undefined;
    return {
      ok: false,
      errorClass: classifyHttpError(response.status, providerCode),
      providerCode,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    };
  }
}

function classifyHttpError(status: number, code: string | undefined): PaymentGatewayErrorClass {
  if (status === 401 || status === 403) return 'configuration';
  if (status === 429) return 'rate_limited';
  if (code === 'PAYMENT_METHOD_MAINTENANCE') return 'method_maintenance';
  if (status >= 500) return 'provider_unavailable';
  return 'provider_rejected';
}

/** 只有对方明确说“上游暂时不可用”、限流、或我们没拿到响应时才重试；PROVIDER_ERROR 官方定义为不可恢复。 */
function isRetryable(outcome: Extract<RequestOutcome, { ok: false }>): boolean {
  if (outcome.errorClass === 'timeout' || outcome.errorClass === 'network') return true;
  if (outcome.errorClass === 'rate_limited') return true;
  return (
    outcome.errorClass === 'provider_unavailable' &&
    outcome.providerCode === 'PROVIDER_UPSTREAM_UNAVAILABLE'
  );
}

function failure(errorClass: PaymentGatewayErrorClass, providerCode?: string) {
  return {
    success: false as const,
    errorClass,
    errorMessage: USER_MESSAGES[errorClass],
    ...(providerCode ? { providerCode } : {}),
  };
}

function adminError(action: string, outcome: Extract<RequestOutcome, { ok: false }>): Error {
  return new Error(
    `${action}失败：${outcome.errorClass}${outcome.providerCode ? ` (${outcome.providerCode})` : ''}`
  );
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  return Number(value) * 1000;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

function parseHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function isHttpsUrl(value: string): boolean {
  return parseHttpsUrl(value) !== null;
}
