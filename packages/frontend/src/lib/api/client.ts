import type { ApiResponse } from '@miniapp/shared';
import { getRawInitData, INIT_DATA_HEADER } from '@/lib/telegram/auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/** 统一的 HTTP 客户端。仅在 lib/api/ 内部使用；业务层必须走 React Query hook 包装。 */
export async function apiClient<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_URL}${path}`;

  const initData = getRawInitData();
  const headers = new Headers(options?.headers);
  headers.set('Content-Type', 'application/json');
  if (initData) headers.set(INIT_DATA_HEADER, initData);

  const res = await fetch(url, { ...options, headers });

  if (!res.ok) {
    throw new Error(`API error: ${res.status}`);
  }

  const json = (await res.json()) as ApiResponse<T>;

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
  headers.set('Content-Type', 'application/json');
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
          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.content) {
              fullContent += parsed.content;
              onChunk(fullContent);
            }
          } catch (e) {
            console.warn('Failed to parse SSE chunk:', dataStr);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
