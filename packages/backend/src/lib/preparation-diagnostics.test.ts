import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { info, distribution } = vi.hoisted(() => ({ info: vi.fn(), distribution: vi.fn() }));
vi.mock('./logger.js', () => ({ logger: { info } }));
vi.mock('@sentry/node', () => ({ metrics: { distribution } }));
import {
  observedSupabaseFetch,
  registerPreparationDiagnostics,
} from './preparation-diagnostics.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  info.mockReset();
  distribution.mockReset();
});

describe('Supabase header wait diagnostics', () => {
  it('preserves fetch arguments, signal and the unconsumed response', async () => {
    const response = new Response('untouched');
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetch);
    const input = 'https://example.invalid/rest/v1/users?id=eq.private-value';
    const init = { signal: new AbortController().signal, headers: { authorization: 'test-only' } };
    expect(await observedSupabaseFetch(input, init)).toBe(response);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(input, init);
    expect(response.bodyUsed).toBe(false);
    expect(info).not.toHaveBeenCalled();
  });

  it('reports outstanding waits once and clears the timer on success', async () => {
    vi.useFakeTimers();
    let resolve!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          })
      )
    );
    const result = observedSupabaseFetch(
      'https://example.invalid/rest/v1/rpc/begin_chat_generation_observation?private=hidden'
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatchObject({
      outcome: 'pending',
      resource: 'begin_chat_generation_observation',
    });
    resolve(new Response('{}'));
    await result;
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/example|private|hidden/);
  });

  it('preserves abort errors and records only sanitized fields', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = new Error('private error body');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
    await expect(
      observedSupabaseFetch('https://example.invalid/rest/v1/users?secret=hidden', {
        signal: controller.signal,
      })
    ).rejects.toBe(error);
    expect(info.mock.calls[0]?.[0]).toMatchObject({ outcome: 'aborted', resource: 'users' });
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/secret|hidden|private|example/);
  });

  it('does not let telemetry errors replace HTTP errors or successful responses', async () => {
    info.mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    distribution.mockImplementation(() => {
      throw new Error('metric unavailable');
    });
    const response = new Response('', { status: 503 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    expect(await observedSupabaseFetch('https://example.invalid/rest/v1/unknown_name')).toBe(
      response
    );
    expect(info.mock.calls[0]?.[0]).toMatchObject({
      resource: 'other',
      outcome: 'error',
      status: 503,
    });
  });
});

describe('HTTP preparation lifecycle', () => {
  it('works through the production-style plugin prefix and isolates metric failures', async () => {
    const app = Fastify();
    registerPreparationDiagnostics(app);
    distribution.mockImplementation(() => {
      throw new Error('metrics unavailable');
    });
    await app.register(
      async (routes) => {
        routes.post('/:id/regenerate', { preHandler: async () => {} }, async () => ({ ok: true }));
      },
      { prefix: '/api/v1/conversations' }
    );
    try {
      const reply = await app.inject({
        method: 'POST',
        url: '/api/v1/conversations/test/regenerate',
      });
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toEqual({ ok: true });
      expect(distribution).toHaveBeenCalledTimes(4);
    } finally {
      await app.close();
    }
  });
  it('includes route auth and closes successful requests before the handler', async () => {
    const app = Fastify();
    registerPreparationDiagnostics(app);
    app.post(
      '/api/v1/conversations/:id/messages',
      {
        preHandler: async () => {
          distribution.mockClear();
        },
      },
      async () => {
        expect(distribution).toHaveBeenCalledWith(
          'prep.dependency.duration',
          expect.any(Number),
          expect.objectContaining({ attributes: expect.objectContaining({ stage: 'pre_handler' }) })
        );
        return {};
      }
    );
    try {
      const reply = await app.inject({
        method: 'POST',
        url: '/api/v1/conversations/test/messages',
        payload: {},
      });
      expect(reply.statusCode).toBe(200);
      expect(distribution).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('records auth rejection and malformed JSON without measuring normal routes', async () => {
    const app = Fastify();
    registerPreparationDiagnostics(app);
    app.post(
      '/api/v1/conversations/:id/messages',
      {
        preHandler: async (_request, reply) => {
          await reply.code(401).send({});
        },
      },
      async () => ({})
    );
    app.get('/ordinary', async () => ({}));
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/conversations/test/messages',
            payload: {},
          })
        ).statusCode
      ).toBe(401);
      expect(distribution.mock.calls.some((call) => call[2].attributes.outcome === 'error')).toBe(
        true
      );
      distribution.mockClear();
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/conversations/test/messages',
            headers: { 'content-type': 'application/json' },
            payload: '{',
          })
        ).statusCode
      ).toBe(400);
      expect(distribution.mock.calls.some((call) => call[2].attributes.outcome === 'error')).toBe(
        true
      );
      distribution.mockClear();
      await app.inject('/ordinary');
      expect(distribution).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
