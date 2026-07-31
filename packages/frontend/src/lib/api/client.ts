import * as Sentry from '@sentry/nextjs';
import type { ApiResponse } from '@miniapp/shared';
import { getRawInitData, INIT_DATA_HEADER } from '@/lib/telegram/auth';
import { createLogger } from '@/lib/logger';
import { sendSentryLog } from '@/lib/sentry/client';
import { getFirstChatCorrelation } from '@/lib/sentry/first-chat-telemetry';
import { getActiveBootSessionId } from '@/lib/bridge/boot-session';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://stminiapp-development.up.railway.app';

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

function applyTelemetryHeaders(headers: Headers): void {
  const bootSessionId = getActiveBootSessionId();
  if (bootSessionId) headers.set('X-Boot-Session-Id', bootSessionId);
  const correlation = getFirstChatCorrelation();
  if (!correlation) return;

  headers.set('X-First-Chat-Journey-Id', correlation.journeyId);
  headers.set('X-First-Chat-Attempt-Id', correlation.attemptId);
  const traceData = Sentry.getTraceData();
  const sentryTrace = traceData['sentry-trace'];
  if (sentryTrace) headers.set('sentry-trace', sentryTrace);
  if (traceData.baggage) headers.set('baggage', traceData.baggage);
}

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

/** 统一的 HTTP 客户端。仅在 lib/api/ 内部使用；业务层必须走 React Query hook 包装。 */
export async function apiClient<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_URL}${path}`;

  const initData = getRawInitData();
  const headers = new Headers(options?.headers);
  const requestId = createRequestId();
  headers.set('X-Request-Id', requestId);
  applyTelemetryHeaders(headers);
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
    if (json && !json.success) {
      throw new ApiClientError(json.error.message, res.status, json.error.code);
    }
    throw new ApiClientError(`API error: ${res.status}`, res.status);
  }

  if (!json) {
    throw new Error('API response is empty');
  }

  if (!json.success) {
    throw new Error(json.error.message);
  }

  return json.data;
}

/**
 * 处理 SSE (Server-Sent Events) 流式请求的客户端。
 * 业务层通过 onChunk 回调接收累加的文本内容。
 */
export async function apiStreamClient(
  path: string,
  options: RequestInit,
  onChunk: (text: string) => void
): Promise<void> {
  const url = `${API_URL}${path}`;

  const initData = getRawInitData();
  const headers = new Headers(options?.headers);
  const requestId = createRequestId();
  headers.set('X-Request-Id', requestId);
  applyTelemetryHeaders(headers);
  if (options?.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (initData) headers.set(INIT_DATA_HEADER, initData);

  const res = await fetch(url, { ...options, headers }).catch((error: unknown) => {
    recordFailedRequest(requestId, path, options.method ?? 'GET', 0);
    throw error;
  });

  if (!res.ok) {
    recordFailedRequest(requestId, path, options.method ?? 'GET', res.status);
    throw new Error(`API error: ${res.status}`);
  }

  if (!res.body) {
    throw new Error('Response body is empty');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let fullContent = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('data: ')) {
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') {
            return;
          }

          let parsed;
          try {
            parsed = JSON.parse(dataStr);
          } catch (e) {
            log.warn('Failed to parse SSE chunk:', dataStr);
            continue;
          }

          if (parsed.error) {
            throw new Error(parsed.error);
          }

          if (parsed.content) {
            fullContent += parsed.content;
            onChunk(fullContent);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
