import { beforeEach, describe, expect, it, vi } from 'vitest';

const { distribution, count } = vi.hoisted(() => ({ distribution: vi.fn(), count: vi.fn() }));

vi.mock('@sentry/node', () => ({
  metrics: { distribution, count, gauge: vi.fn() },
}));

import { classifyRequest, measureDbOperation, statusClass } from './perf-metrics.js';

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
