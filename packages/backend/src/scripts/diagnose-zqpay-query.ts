/**
 * backend / scripts / diagnose-zqpay-query.ts
 *
 * 只读诊断：查单请求究竟发到了哪里、厂商回了什么。
 *
 * 起因是 development 验证 cron 时「厂商返回了 HTML 页面」，而 queryOrder 直接
 * await response.json()，既不看状态码也不看 content-type，异常被 catch 吞掉后
 * 统一替换成 '支付系统暂时不可用'，日志里查不到任何现场。
 *
 * 本脚本不复制签名逻辑，而是包一层 fetch 后驱动真实的 ZqPaymentGateway.queryOrder()，
 * 所以 URL 拼接、参数集、RSA 签名与生产完全一致，不存在实现漂移。
 *
 * 不写库、不入账、不改任何订单状态；密钥一律不输出。
 *
 *   pnpm --filter @miniapp/backend payment:diagnose-query -- <订单号>
 *   pnpm exec railway run -e development -s stminiapp -- \
 *     pnpm --filter @miniapp/backend payment:diagnose-query -- <订单号>
 */

import 'dotenv/config';
import { ZqPaymentGateway } from '../infrastructure/payment/ZqPaymentGateway.js';

/** 没传订单号时用它探连通性：厂商会回「订单不存在」之类的业务错误，同样能证明通路是 JSON。 */
const PROBE_ORDER_ID = 'MA_DIAGNOSE_PROBE_0000';
const BODY_PREVIEW_LIMIT = 300;

interface CapturedExchange {
  requestUrl: string;
  requestMethod: string;
  requestParamNames: string[];
  finalUrl: string;
  redirected: boolean;
  status: number;
  contentType: string | null;
  bodyLength: number;
  bodyPreview: string;
}

let captured: CapturedExchange | null = null;
let transportError: unknown = null;

// 经函数读取：captured 只在 fetch 包装器里赋值，直接引用会被控制流分析收窄成 null。
function getCaptured(): CapturedExchange | null {
  return captured;
}

function getTransportError(): unknown {
  return transportError;
}

function maskTail(value: string): string {
  if (!value) return '(empty)';
  if (value.length <= 2) return '*'.repeat(value.length);
  return `${'*'.repeat(value.length - 2)}${value.slice(-2)}`;
}

function describeSecret(value: string): string {
  return value ? `set (length=${value.length})` : 'MISSING';
}

function readRequestParamNames(init: RequestInit | undefined): string[] {
  const body = init?.body;
  if (typeof body !== 'string' && !(body instanceof URLSearchParams)) return [];
  const params = typeof body === 'string' ? new URLSearchParams(body) : body;
  return [...params.keys()].sort();
}

/**
 * 包一层 fetch，把原始响应在 gateway 解析之前先抄一份。
 * 用 clone() 读取，不消费 gateway 要用的那个 body。
 */
function installFetchProbe(): void {
  const realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    try {
      const response = await realFetch(input, init);
      const text = await response.clone().text();
      captured = {
        requestUrl,
        requestMethod: init?.method ?? (input instanceof Request ? input.method : 'GET'),
        requestParamNames: readRequestParamNames(init),
        finalUrl: response.url,
        redirected: response.redirected,
        status: response.status,
        contentType: response.headers.get('content-type'),
        bodyLength: text.length,
        bodyPreview: text.slice(0, BODY_PREVIEW_LIMIT).replace(/\s+/g, ' ').trim(),
      };
      return response;
    } catch (error) {
      transportError = error;
      throw error;
    }
  }) as typeof globalThis.fetch;
}

function verdict(exchange: CapturedExchange): string {
  const isHtml =
    (exchange.contentType ?? '').toLowerCase().includes('html') ||
    exchange.bodyPreview.startsWith('<');

  if (isHtml) {
    return [
      'HTML —— 复现成功。厂商文档确认查单地址就是 /api/pay/query，且该端点对任何错误入参',
      '都返回 JSON，所以 HTML 只可能来自「请求没打到这个端点」或「中间有东西拦截了」。',
      '重点看上面的 finalUrl 和 redirected：finalUrl 与 requestUrl 不一致说明发生了跳转；',
      '一致则说明是出口侧（CDN/WAF）按路径返回了拦截页。',
    ].join('\n  ');
  }
  if ((exchange.contentType ?? '').toLowerCase().includes('json')) {
    return 'JSON —— 通路正常。此环境的查单接口可用，HTML 问题不在这条路径上。';
  }
  return `非 JSON 非 HTML（content-type=${exchange.contentType ?? 'unknown'}）—— 需人工判读上面的响应片段。`;
}

const orderId = process.argv[2]?.trim() || PROBE_ORDER_ID;

const baseUrl = process.env.PAYMENT_BASE_URL || 'https://zq.716faka.com';
const merchantId = process.env.PAYMENT_MERCHANT_ID || '';
const merchantPrivateKey = process.env.PAYMENT_MERCHANT_PRIVATE_KEY || '';
const platformPublicKey = process.env.PAYMENT_PLATFORM_PUBLIC_KEY || '';
const notifyUrl = process.env.PAYMENT_NOTIFY_URL || '';
const returnUrl = process.env.PAYMENT_RETURN_URL || '';

console.log('=== 1. 配置现状（密钥只报是否存在与长度） ===');
console.log(`  PAYMENT_ENABLED              : ${process.env.PAYMENT_ENABLED ?? '(unset)'}`);
console.log(`  PAYMENT_BASE_URL             : ${baseUrl}`);
console.log(
  `  PAYMENT_MERCHANT_ID          : ${maskTail(merchantId)} (length=${merchantId.length})`
);
console.log(`  PAYMENT_MERCHANT_PRIVATE_KEY : ${describeSecret(merchantPrivateKey)}`);
console.log(`  PAYMENT_PLATFORM_PUBLIC_KEY  : ${describeSecret(platformPublicKey)}`);
console.log(`  PAYMENT_NOTIFY_URL           : ${notifyUrl || '(empty)'}`);
console.log(`  PAYMENT_RETURN_URL           : ${returnUrl || '(empty)'}`);
console.log(
  `  查询订单号                    : ${orderId}${orderId === PROBE_ORDER_ID ? '（未传参，使用探测订单号）' : ''}`
);
console.log();

// isConfigured() 要求这六项全部非空，缺任何一项 queryOrder 会直接返回而不发出任何 HTTP 请求。
const missing = [
  ['PAYMENT_BASE_URL', baseUrl],
  ['PAYMENT_MERCHANT_ID', merchantId],
  ['PAYMENT_MERCHANT_PRIVATE_KEY', merchantPrivateKey],
  ['PAYMENT_PLATFORM_PUBLIC_KEY', platformPublicKey],
  ['PAYMENT_NOTIFY_URL', notifyUrl],
  ['PAYMENT_RETURN_URL', returnUrl],
]
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length > 0) {
  console.log('=== 结论 ===');
  console.log(`  缺少配置：${missing.join(', ')}`);
  console.log('  isConfigured() 为 false，queryOrder() 会直接返回「支付参数未配置」，');
  console.log('  一个 HTTP 请求都不会发出——这种情况下不可能收到 HTML，需先补齐变量再诊断。');
  process.exit(1);
}

installFetchProbe();

const gateway = new ZqPaymentGateway({
  baseUrl,
  merchantId,
  merchantPrivateKey,
  platformPublicKey,
  notifyUrl,
  returnUrl,
});

const result = await gateway.queryOrder(orderId);

const exchange = getCaptured();
const failure = getTransportError();

console.log('=== 2. 实际发出的请求 ===');
if (exchange) {
  console.log(`  requestUrl   : ${exchange.requestUrl}`);
  console.log(`  method       : ${exchange.requestMethod}`);
  console.log(`  参数字段名    : ${exchange.requestParamNames.join(', ') || '(none)'}`);
} else {
  console.log('  未捕获到任何 HTTP 请求。');
}
console.log();

console.log('=== 3. 厂商实际返回 ===');
if (exchange) {
  console.log(`  finalUrl     : ${exchange.finalUrl}`);
  console.log(`  redirected   : ${exchange.redirected}`);
  console.log(`  status       : ${exchange.status}`);
  console.log(`  content-type : ${exchange.contentType ?? '(none)'}`);
  console.log(`  body length  : ${exchange.bodyLength}`);
  console.log(`  body 前 ${BODY_PREVIEW_LIMIT} 字节:`);
  console.log(`    ${exchange.bodyPreview}`);
} else if (failure) {
  const message = failure instanceof Error ? failure.message : String(failure);
  const cause =
    failure instanceof Error && failure.cause instanceof Error
      ? ` / cause: ${failure.cause.message}`
      : '';
  console.log(`  请求未能完成（连不上或超时）：${message}${cause}`);
} else {
  console.log('  没有请求也没有传输异常——说明在发请求之前就返回了。');
}
console.log();

console.log('=== 4. queryOrder() 解析后的返回值（生产代码看到的东西） ===');
console.log(`  ${JSON.stringify(result)}`);
console.log();

console.log('=== 5. 判定 ===');
console.log(`  ${exchange ? verdict(exchange) : '未发出请求，无法判定，见上面第 3 段。'}`);

process.exit(0);
