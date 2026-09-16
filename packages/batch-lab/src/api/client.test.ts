import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BatchLabClientError, previewBatchLabProcessor, request } from './client';

const successSchema = z.object({ success: z.literal(true), data: z.string() });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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

  it('previews a processor through the shared response schema', async () => {
    vi.stubEnv('VITE_BATCH_LAB_API_URL', 'http://test');
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://test/api/batch-lab/processors/preview');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        config: { protocol: 'none_v1' },
        input_text: 'hello',
      });
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
            processor_version_id: '87fce0db-a75e-45b7-87be-b8e7edc8ae8f',
            processor_digest: `sha256:${'a'.repeat(64)}`,
            status: 'success',
            match_count: 0,
            input_text: 'hello',
            output_text: 'hello',
            sanitized_html: 'hello',
            error_code: null,
            renderer: { protocol: 'batch_lab_html_v1', version: 1 },
            created_at: '2026-09-11T06:00:00.000Z',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      previewBatchLabProcessor({ config: { protocol: 'none_v1' }, input_text: 'hello' }, undefined)
    ).resolves.toMatchObject({ status: 'success', output_text: 'hello' });
  });
});
