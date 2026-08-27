import * as Sentry from '@sentry/nextjs';
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

export interface ApiClientBalanceDetail {
  creditsRequired: number;
  creditsAvailable: number;
}

export class ApiClientError extends Error {
  readonly balance?: ApiClientBalanceDetail;
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    balance?: ApiClientBalanceDetail
  ) {
    super(message);
    this.name = 'ApiClientError';
    if (balance) this.balance = balance;
  }
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
  const json = (await res.json().catch(() => null)) as
    | { success: true; data: T }
    | { success: false; error: { code: string; message: string } }
    | {
        error: {
          type: string;
          message?: string;
          credits_required?: number;
          credits_available?: number;
        };
      }
    | null;

  if (!res.ok) {
    log.error(`Error ${res.status} for ${url}:`, json);
    recordFailedRequest(requestId, path, options?.method ?? 'GET', res.status);

    // 402 余额不足走裸形状 InsufficientBalanceErrorResponse（与对话链路同形状），
    // 标准 envelope 装不下两个金额。这里认出它并把金额带出去，供调用方跳充值页带 required。
    if (
      json &&
      typeof json === 'object' &&
      'error' in json &&
      json.error &&
      typeof json.error === 'object' &&
      (json.error as { type?: string }).type === 'insufficient_balance'
    ) {
      const error = json.error as {
        message?: string;
        credits_required?: number;
        credits_available?: number;
      };
      throw new ApiClientError(
        error.message ?? '星尘余额不足',
        res.status,
        'insufficient_balance',
        {
          creditsRequired: Number(error.credits_required ?? 0),
          creditsAvailable: Number(error.credits_available ?? 0),
        }
      );
    }

    if (json && 'success' in json && json.success === false) {
      throw new ApiClientError(json.error.message, res.status, json.error.code);
    }
    throw new ApiClientError(`API error: ${res.status}`, res.status);
  }

  if (!json) {
    throw new Error('API response is empty');
  }

  if ('success' in json && !json.success) {
    throw new Error(json.error.message);
  }

  return (json as { success: true; data: T }).data;
}
