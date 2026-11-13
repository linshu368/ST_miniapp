import * as Sentry from '@sentry/nextjs';
import type { ApiResponse } from '@miniapp/shared';
import { getRawInitData, INIT_DATA_HEADER } from '@/lib/telegram/auth';
import { createLogger } from '@/lib/logger';
import { sendSentryLog } from '@/lib/sentry/client';
import {
  createRequestId,
  DEFAULT_REQUEST_TIMEOUT_MS,
  RequestTimeoutError,
  timedFetch,
} from '@/lib/perf/request-timing';
import type { RequestPriority } from '@/lib/api/request-concurrency';
import { recordApiAttempt, recordApiTotal, shouldObserveApiTiming } from '@/lib/perf/api-timing';

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL || 'https://stminiapp-development.up.railway.app';

const log = createLogger('api');

function recordFailedRequest(
  requestId: string,
  path: string,
  method: string,
  status: number
): void {
  Sentry.addBreadcrumb({
    category: 'http',
    level: 'error',
    message: `${method} ${path}`,
    data: { requestId, status },
  });
  sendSentryLog('error', 'api.request_failed', {
    requestId,
    path,
    method,
    status,
  });
}

export interface InsufficientCreditsBalance {
  creditsRequired: number;
  creditsAvailable: number;
}

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly balance?: InsufficientCreditsBalance
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 把非 2xx JSON 翻成 ApiClientError。
 *
 * 余额不足有两种 body：对话/语音 402 是 InsufficientBalanceErrorResponse 裸形状
 *（`error.type`，没有 success）；其余走标准 envelope（`success: false` + `error.code`）。
 * 裸形状必须先认，否则 `!success` 会把它当成缺 code 的 envelope，调用方跳不了充值。
 */
export function toApiClientError(status: number, json: unknown): ApiClientError {
  if (isRecord(json) && isRecord(json.error)) {
    const error = json.error;
    if (error.type === 'insufficient_balance') {
      const message = typeof error.message === 'string' ? error.message : '星尘余额不足';
      return new ApiClientError(message, status, 'insufficient_balance', {
        creditsRequired: Number(error.credits_required ?? 0),
        creditsAvailable: Number(error.credits_available ?? 0),
      });
    }

    if (!json.success) {
      const message = typeof error.message === 'string' ? error.message : `API error: ${status}`;
      const code = typeof error.code === 'string' ? error.code : undefined;
      return new ApiClientError(message, status, code);
    }
  }

  return new ApiClientError(`API error: ${status}`, status);
}

/** 仅供调用方观测；时刻均来自 performance.now()，不含 URL/请求或响应正文。 */
export interface ApiAttemptTiming {
  requestId: string;
  queuedAt: number;
  dispatchedAt?: number;
  headersAt?: number;
  endedAt?: number;
  status?: number;
  /** Next.js proxy reported backend duration; absent for direct backend calls. */
  upstreamMs?: number;
  outcome?: 'ok' | 'timeout' | 'aborted' | 'http_error' | 'error';
}

function proxyUpstreamDuration(value: string | null): number | undefined {
  const match = value?.match(/(?:^|,)\s*backend;dur=([0-9]+(?:\.[0-9]+)?)(?:\s*;|\s*,|\s*$)/i);
  if (!match) return undefined;
  const duration = Number(match[1]);
  return Number.isFinite(duration) && duration >= 0 && duration <= 60_000 ? duration : undefined;
}

/** 单次请求超时（毫秒）；不传则按路径取默认值。 */
export type ApiRequestInit = Omit<RequestInit, 'priority'> & {
  timeoutMs?: number;
  /** A declared single-attempt experiment must retain the first transport failure. */
  transportRetry?: false;
  /** 只读且可安全重放的非 GET 请求（如 POST /api/dramas/play）沿用 GET 的传输层重试。 */
  idempotent?: true;
  /** 只在明确需要分段计时时传入；回调异常不会影响请求。对象随本次尝试推进。 */
  onAttempt?: (timing: ApiAttemptTiming) => void;
  /**
   * 短请求排队优先级（勿用名 `priority`：会与 Fetch Priority Hints 的 RequestInit.priority 冲突）。
   * 长耗时路径自动 bypass 并发帽。
   */
  queuePriority?: RequestPriority;
};

/** 普通接口 p95 偶发 10 秒，20 秒是「用户已经不会再等」的初值，需按基线校准。 */
const DEFAULT_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_MS;
/** 服务端上游（图片/语音生成、上传）本身最长 180 秒，客户端不能比服务端先放弃。 */
const LONG_RUNNING_TIMEOUT_MS = 200_000;
const LONG_RUNNING_PATHS = [
  /\/messages\/[^/?]+\/(image|image-description|voice)(\?|$)/,
  /\/image-plaza\/conversations\/[^/?]+\/attempts(\?|$)/,
  /\/image-plaza\/references(\?|$)/,
];

/** GET 传输层失败时最多再试 1 次；退避带抖动，避免边缘抖动时齐射。 */
const GET_TRANSPORT_RETRY_MAX = 1;
const GET_RETRY_BASE_DELAY_MS = 200;
const GET_RETRY_JITTER_MS = 300;

function isLongRunningPath(path: string): boolean {
  return LONG_RUNNING_PATHS.some((pattern) => pattern.test(path));
}

function resolveTimeoutMs(path: string): number {
  return isLongRunningPath(path) ? LONG_RUNNING_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

/**
 * 未显式传 priority 时：角色卡/会话详情等入场 P0 为 critical；其余 normal。
 * latest-badge / latest-seen 走 normal，避免和列表抢槽。
 */
export function resolveRequestPriority(
  path: string,
  method: string,
  explicit?: RequestPriority
): RequestPriority | 'bypass' {
  if (isLongRunningPath(path)) return 'bypass';
  if (explicit) return explicit;

  // 角色详情为 P0；latest-badge / latest-seen 不是。
  if (
    method === 'GET' &&
    /^\/api\/characters\/[^/?]+$/.test(path) &&
    !path.endsWith('/latest-badge') &&
    !path.endsWith('/latest-seen')
  ) {
    return 'critical';
  }
  if (method === 'GET' && path.startsWith('/api/characters?')) return 'critical';
  if (method === 'GET' && path === '/api/characters') return 'critical';
  if (method === 'GET' && /^\/api\/v1\/conversations\/[^/?]+$/.test(path)) return 'critical';
  if (
    method === 'POST' &&
    (path === '/api/v1/conversations' || path.startsWith('/api/v1/conversations?'))
  ) {
    return 'critical';
  }
  if (method === 'POST' && path === '/api/image-plaza/conversations') return 'critical';
  if (method === 'GET' && path.startsWith('/api/image-plaza/feed')) return 'critical';
  if (
    method === 'GET' &&
    /^\/api\/image-plaza\/(config|conversations\/[^/?]+|works\/[^/?]+)(\?|$)/.test(path)
  ) {
    return 'critical';
  }
  return 'normal';
}

function resolveMethod(options?: ApiRequestInit): string {
  return (options?.method ?? 'GET').toUpperCase();
}

/** 仅对幂等 GET 的超时/断网重试；调用方取消（React Query abort）绝不重试。 */
export function isRetryableGetTransportError(
  error: unknown,
  method: string,
  externalSignal?: AbortSignal,
  idempotent = false
): boolean {
  if (method !== 'GET' && !idempotent) return false;
  if (externalSignal?.aborted) return false;
  if (error instanceof RequestTimeoutError) return true;
  if (error instanceof ApiClientError && error.code === 'client_timeout') return true;
  if (error instanceof TypeError) return true;
  return false;
}

function toTransportApiError(error: unknown): never {
  if (error instanceof RequestTimeoutError) {
    throw new ApiClientError('请求超时，请检查网络后重试', 0, 'client_timeout');
  }
  // fetch 在连接中途被断开（弱网、WebView 切前后台）时按浏览器实现抛不同的 TypeError
  // （Chrome "Failed to fetch"、Safari "Load failed" 等），原样抛出会在 UI 上露出英文底层报错。
  if (error instanceof TypeError) {
    throw new ApiClientError('网络连接中断，请检查网络后重试', 0, 'network_error');
  }
  throw error;
}

function retryDelayMs(): number {
  return GET_RETRY_BASE_DELAY_MS + Math.floor(Math.random() * (GET_RETRY_JITTER_MS + 1));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
    );
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(
        signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
      );
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function apiClientOnce<T>(
  path: string,
  options?: ApiRequestInit,
  timing?: ApiAttemptTiming
): Promise<T> {
  const url = `${API_URL}${path}`;

  const initData = getRawInitData();
  const headers = new Headers(options?.headers);
  const requestId = timing?.requestId ?? createRequestId();
  headers.set('X-Request-Id', requestId);
  if (options?.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (initData) headers.set(INIT_DATA_HEADER, initData);

  log.debug(`Fetching ${url}`, { hasInitData: !!initData });

  const {
    timeoutMs,
    queuePriority: _queuePriority,
    onAttempt: _onAttempt,
    transportRetry: _transportRetry,
    idempotent: _idempotent,
    ...fetchOptions
  } = options ?? {};
  return timedFetch(
    url,
    { ...fetchOptions, headers },
    {
      requestId,
      timeoutMs: timeoutMs ?? resolveTimeoutMs(path),
      // The timer must start before acquiring a slot, including on retries.
      priority: resolveRequestPriority(path, resolveMethod(options), options?.queuePriority),
      onDispatch: () => {
        if (timing) timing.dispatchedAt = performance.now();
      },
    },
    async (res) => {
      if (timing) {
        timing.headersAt = performance.now();
        timing.status = res.status;
        timing.upstreamMs = proxyUpstreamDuration(res.headers.get('Server-Timing'));
      }
      const json = (await res.json().catch((error: unknown) => {
        // Abort must reach timedFetch so an active body deadline remains a real timeout.
        if (options?.signal?.aborted || (error instanceof Error && error.name === 'AbortError'))
          throw error;
        return null;
      })) as ApiResponse<T> | null;

      if (!res.ok) {
        log.error(`Error ${res.status} for ${url}:`, json);
        recordFailedRequest(requestId, path, resolveMethod(options), res.status);
        throw toApiClientError(res.status, json);
      }

      if (!json) throw new Error('API response is empty');
      if (!json.success) throw new Error(json.error.message);
      return json.data;
    }
  ).catch((error: unknown) => {
    if (!(error instanceof ApiClientError))
      recordFailedRequest(requestId, path, resolveMethod(options), 0);
    // 保留 RequestTimeoutError，供外层决定是否对 GET 再试一次。
    throw error;
  });
}

/**
 * 统一的 HTTP 客户端。仅在 lib/api/ 内部使用；业务层必须走 React Query hook 包装。
 *
 * GET 在超时或网络失败时最多再试 1 次（新 requestId），用于吸收客户端→Railway
 * 的瞬时抖动；HTTP 业务错误与调用方 abort 不重试。短请求经并发帽排队，critical 插队。
 */
export async function apiClient<T>(path: string, options?: ApiRequestInit): Promise<T> {
  const method = resolveMethod(options);
  const idempotent = method === 'GET' || options?.idempotent === true;
  const maxAttempts =
    idempotent && options?.transportRetry !== false ? 1 + GET_TRANSPORT_RETRY_MAX : 1;
  const signal = options?.signal ?? undefined;
  const observe = shouldObserveApiTiming(path);
  const startedAt = observe ? performance.now() : 0;
  let lastTiming: ApiAttemptTiming | undefined;

  let attempt = 0;
  try {
    for (;;) {
      try {
        // 每次尝试单独占槽；退避在槽外，避免重试等待堵死其它 P0。
        const timing: ApiAttemptTiming | undefined =
          options?.onAttempt || observe
            ? { requestId: createRequestId(), queuedAt: performance.now() }
            : undefined;
        lastTiming = timing;
        if (timing) {
          try {
            options?.onAttempt?.(timing);
          } catch {
            /* 观测不能改变请求语义。 */
          }
        }
        try {
          const result = await apiClientOnce<T>(path, options, timing);
          if (timing) timing.outcome = 'ok';
          return result;
        } catch (error) {
          if (timing)
            timing.outcome = signal?.aborted
              ? 'aborted'
              : error instanceof RequestTimeoutError
                ? 'timeout'
                : error instanceof ApiClientError
                  ? 'http_error'
                  : 'error';
          throw error;
        } finally {
          if (timing) {
            timing.endedAt = performance.now();
            if (observe) recordApiAttempt(path, method, timing, attempt + 1);
          }
        }
      } catch (error) {
        attempt += 1;
        if (signal?.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException('Aborted', 'AbortError');
        }
        if (
          attempt >= maxAttempts ||
          !isRetryableGetTransportError(error, method, signal, idempotent)
        ) {
          toTransportApiError(error);
        }
        const delayMs = retryDelayMs();
        log.warn(`${method} transport retry after ${delayMs}ms`, { path, attempt });
        await sleep(delayMs, signal);
      }
    }
  } finally {
    if (observe && lastTiming) {
      recordApiTotal(path, method, startedAt, lastTiming, Math.min(attempt + 1, maxAttempts));
    }
  }
}
