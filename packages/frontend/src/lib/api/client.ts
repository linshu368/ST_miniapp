import * as Sentry from '@sentry/nextjs';
import type { ApiResponse } from '@miniapp/shared';
import { getRawInitData, INIT_DATA_HEADER } from '@/lib/telegram/auth';
import { createLogger } from '@/lib/logger';
import { sendSentryLog } from '@/lib/sentry/client';

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL || 'https://stminiapp-development.up.railway.app';

const log = createLogger('api');

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

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

/** 统一的 HTTP 客户端。仅在 lib/api/ 内部使用；业务层必须走 React Query hook 包装。 */
export async function apiClient<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_URL}${path}`;

  const initData = getRawInitData();
  const headers = new Headers(options?.headers);
  const requestId = createRequestId();
  headers.set('X-Request-Id', requestId);
  if (options?.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (initData) headers.set(INIT_DATA_HEADER, initData);

  log.debug(`Fetching ${url}`, { hasInitData: !!initData });

  const res = await fetch(url, { ...options, headers }).catch((error: unknown) => {
    recordFailedRequest(requestId, path, options?.method ?? 'GET', 0);
    throw error;
  });
  const json = (await res.json().catch(() => null)) as ApiResponse<T> | null;

  if (!res.ok) {
    log.error(`Error ${res.status} for ${url}:`, json);
    recordFailedRequest(requestId, path, options?.method ?? 'GET', res.status);
    throw toApiClientError(res.status, json);
  }

  if (!json) {
    throw new Error('API response is empty');
  }

  if (!json.success) {
    throw new Error(json.error.message);
  }

  return json.data;
}
