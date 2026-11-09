import { paymentFailure, type PaymentGatewayErrorClass } from './PaymentGateway.js';

type FormResponse =
  | { success: true; body: Record<string, unknown> }
  | ReturnType<typeof paymentFailure>;

/** 不跟随重定向，防止 POST 表单中的商户密钥被转发到其他地址。 */
export async function postEpayForm(
  url: string,
  fields: Record<string, string>,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<FormResponse> {
  return requestEpay(url, fields, 'POST', timeoutMs, parentSignal);
}

/** The user explicitly selected the documented GET lookup. Never log its credential-bearing URL. */
export async function queryEpay(
  url: string,
  fields: Record<string, string>,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<FormResponse> {
  return requestEpay(url, fields, 'GET', timeoutMs, parentSignal);
}

async function requestEpay(
  endpoint: string,
  fields: Record<string, string>,
  method: 'POST' | 'GET',
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<FormResponse> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(parentSignal ? [parentSignal] : []),
  ]);
  try {
    signal.throwIfAborted();
    const form = new URLSearchParams(fields).toString();
    const url = method === 'GET' ? `${endpoint}?${form}` : endpoint;
    const response = await fetch(url, {
      method,
      redirect: 'error',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json',
        'User-Agent': 'MIJINGAI-Backend/1.0',
      },
      ...(method === 'POST' ? { body: form } : {}),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return paymentFailure(httpErrorClass(response.status), `HTTP_${response.status}`);
    }
    const body = await readBoundedJson(response, signal);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return paymentFailure('response_invalid');
    }
    return { success: true, body: body as Record<string, unknown> };
  } catch (err) {
    // fetch 的错误可能带完整请求信息；只暴露稳定类别，不记录表单或原始上游错误。
    if (signal.aborted) return paymentFailure('timeout');
    if (err instanceof SyntaxError || err instanceof RangeError) {
      return paymentFailure('response_invalid');
    }
    return paymentFailure('network');
  }
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new SyntaxError('empty payment response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) throw new RangeError('oversized payment response');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    signal.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => undefined);
  }
}

function httpErrorClass(status: number): PaymentGatewayErrorClass {
  if (status === 401 || status === 403) return 'configuration';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'provider_rejected';
}
