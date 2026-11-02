import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const { distribution, count } = vi.hoisted(() => ({ distribution: vi.fn(), count: vi.fn() }));

vi.mock('@sentry/node', () => ({
  metrics: { distribution, count, gauge: vi.fn() },
}));

import {
  classifyRequest,
  measureDbOperation,
  registerRequestPerf,
  startSseResponseMetric,
  statusClass,
} from './perf-metrics.js';

describe('classifyRequest', () => {
  it('separates long-running generation routes from standard ones', () => {
    expect(classifyRequest('POST', '/api/v1/conversations/:id/messages')).toBe('generation');
    expect(classifyRequest('POST', '/api/v1/conversations/:id/regenerate')).toBe('generation');
    expect(classifyRequest('GET', '/api/v1/conversations/:id')).toBe('standard');
    // 同一路径不同方法不能被误归类。
    expect(classifyRequest('GET', '/api/v1/conversations/:id/messages')).toBe('standard');
  });
});

describe('statusClass', () => {
  it('buckets status codes', () => {
    expect(statusClass(200)).toBe('2xx');
    expect(statusClass(404)).toBe('4xx');
    expect(statusClass(500)).toBe('5xx');
  });
});

describe('Sentry SSE response timing', () => {
  beforeEach(() => {
    distribution.mockClear();
    count.mockClear();
  });

  it('records first visible token once and does not replace it at terminal state', () => {
    const reply = {} as FastifyReply;
    const metric = startSseResponseMetric(
      reply,
      '/api/v1/conversations/:id/messages',
      performance.now() - 25
    );

    metric.firstVisibleToken();
    metric.firstVisibleToken();
    metric.finish(200);

    expect(distribution).toHaveBeenCalledTimes(1);
    expect(distribution).toHaveBeenCalledWith(
      'http.server.duration',
      expect.any(Number),
      expect.objectContaining({
        attributes: expect.objectContaining({ response_milestone: 'first_visible_token' }),
      })
    );
  });

  it('records terminal duration when no visible token was delivered', () => {
    const metric = startSseResponseMetric(
      {} as FastifyReply,
      '/api/v1/conversations/:id/regenerate',
      performance.now() - 25
    );

    metric.finish(502);

    expect(distribution).toHaveBeenCalledWith(
      'http.server.duration',
      expect.any(Number),
      expect.objectContaining({
        attributes: expect.objectContaining({
          status_class: '5xx',
          response_milestone: 'terminal_without_visible_token',
        }),
      })
    );
  });

  it('never lets a Sentry metrics failure affect the SSE request', () => {
    distribution.mockImplementationOnce(() => {
      throw new Error('sentry down');
    });
    const metric = startSseResponseMetric({} as FastifyReply, '/api/v1/conversations/:id/messages');

    expect(() => metric.firstVisibleToken()).not.toThrow();
    expect(count).toHaveBeenCalledWith(
      'perf.instrument_error',
      1,
      expect.objectContaining({
        attributes: { side: 'backend', stage: 'http_server_duration' },
      })
    );
  });

  it('keeps full stream duration separate after first-token timing takes ownership', async () => {
    let onResponse: ((request: FastifyRequest, reply: FastifyReply) => Promise<void>) | undefined;
    const app = {
      addHook: (_name: string, hook: typeof onResponse) => {
        onResponse = hook;
      },
    } as unknown as FastifyInstance;
    registerRequestPerf(app);
    const reply = { elapsedTime: 40_000, statusCode: 200 } as FastifyReply;
    const metric = startSseResponseMetric(reply, '/api/v1/conversations/:id/messages');
    metric.firstVisibleToken();

    await onResponse?.(
      {
        method: 'POST',
        routeOptions: { url: '/api/v1/conversations/:id/messages' },
        log: { warn: vi.fn() },
      } as unknown as FastifyRequest,
      reply
    );

    expect(distribution.mock.calls.map((call) => call[0])).toEqual([
      'http.server.duration',
      'sse.stream.duration',
    ]);
  });
});

describe('measureDbOperation', () => {
  beforeEach(() => {
    distribution.mockClear();
    count.mockClear();
  });

  it('returns the result unchanged and records ok', async () => {
    await expect(measureDbOperation('character', 'findMany', async () => [1, 2])).resolves.toEqual([
      1, 2,
    ]);
    expect(distribution.mock.calls[0]?.[2]).toMatchObject({
      attributes: { model: 'character', operation: 'findMany', outcome: 'ok' },
    });
  });

  it('marks Prisma pool timeouts and rethrows the original error', async () => {
    const poolTimeout = Object.assign(new Error('Timed out fetching a new connection'), {
      code: 'P2024',
    });
    await expect(
      measureDbOperation('character', 'findFirst', () => Promise.reject(poolTimeout))
    ).rejects.toBe(poolTimeout);
    expect(distribution.mock.calls[0]?.[2]).toMatchObject({
      attributes: { outcome: 'pool_timeout' },
    });
  });

  it('never breaks the query when metrics reporting itself fails', async () => {
    distribution.mockImplementationOnce(() => {
      throw new Error('sentry down');
    });
    await expect(measureDbOperation('character', 'count', async () => 7)).resolves.toBe(7);
    expect(count).toHaveBeenCalledWith(
      'perf.instrument_error',
      1,
      expect.objectContaining({ attributes: { side: 'backend', stage: 'db_operation' } })
    );
  });
});
