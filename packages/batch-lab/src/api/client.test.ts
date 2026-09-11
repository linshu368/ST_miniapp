import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BatchLabClientError, request } from './client';

const successSchema = z.object({ success: z.literal(true), data: z.string() });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Batch Lab API client', () => {
  it('does not issue a request for an already cancelled signal', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(
      request('/test', successSchema, { signal: controller.signal, apiBaseUrl: 'http://test' })
    ).rejects.toMatchObject({
      kind: 'cancelled',
      code: 'BATCH_LAB_REQUEST_CANCELLED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('adds request id without adding authorization', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Request-Id')).toBeTruthy();
      expect(headers.has('Authorization')).toBe(false);
      return new Response(JSON.stringify({ success: true, data: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(request('/test', successSchema, { apiBaseUrl: 'http://test' })).resolves.toEqual({
      success: true,
      data: 'ok',
    });
  });

  it('classifies timeout and aborts the transport', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            );
          })
      )
    );
    const pending = request('/test', successSchema, { timeoutMs: 50, apiBaseUrl: 'http://test' });
    const assertion = expect(pending).rejects.toMatchObject({
      kind: 'timeout',
      code: 'BATCH_LAB_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it('rejects a successful HTTP response with an invalid protocol shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 }))
    );
    await expect(request('/test', successSchema, { apiBaseUrl: 'http://test' })).rejects.toEqual(
      expect.objectContaining<Partial<BatchLabClientError>>({
        kind: 'protocol',
        code: 'BATCH_LAB_PROTOCOL_ERROR',
      })
    );
  });
});
