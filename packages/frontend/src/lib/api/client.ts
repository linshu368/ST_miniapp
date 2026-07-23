import type { ApiResponse } from '@miniapp/shared';
import { getRawInitData, INIT_DATA_HEADER } from '@/lib/telegram/auth';
import { createLogger } from '@/lib/logger';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://stminiapp-development.up.railway.app';

const log = createLogger('api');

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
  if (options?.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (initData) headers.set(INIT_DATA_HEADER, initData);

  log.debug(`Fetching ${url}`, { hasInitData: !!initData });

  const res = await fetch(url, { ...options, headers });
  const json = (await res.json().catch(() => null)) as ApiResponse<T> | null;

  if (!res.ok) {
    log.error(`Error ${res.status} for ${url}:`, json);
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
  if (options?.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (initData) headers.set(INIT_DATA_HEADER, initData);

  const res = await fetch(url, { ...options, headers });

  if (!res.ok) {
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
