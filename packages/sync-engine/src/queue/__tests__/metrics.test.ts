/**
 * queue / __tests__ / metrics.test.ts
 *
 * getQueueMetrics() 测试。
 *
 * 测试重点：
 *   1. 区分 pending（attempts=0） vs failed（attempts>0）
 *   2. processing/dead 通过 count 拿到
 *   3. oldest_pending_age_ms 计算正确
 *   4. 查询失败时返回安全默认值，不抛错
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock config ────────────────────────────────────────────────────────────
vi.mock('../../lib/config.js', () => ({
  config: {
    ST_DATA_PATH: '/mock',
    SUPABASE_URL: 'https://mock.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'mock-key',
    ST_BASE_URL: 'http://localhost:8000',
    ST_ADMIN_USERNAME: 'admin',
    ST_ADMIN_PASSWORD: 'pass',
    ST_USER_PASSWORD_SECRET: 'mock-secret-at-least-16',
    HEALTH_PORT: 0,
  },
  loadConfig: vi.fn(),
}));

// ─── Mock Supabase ──────────────────────────────────────────────────────────

let mockPendingRows: { attempts: number }[] = [];
let mockProcessingCount = 0;
let mockDeadCount = 0;
let mockOldestPending: { created_at: string } | null = null;
let mockPendingError: { message: string } | null = null;

function createSelectChain(table: string) {
  return {
    select: vi
      .fn()
      .mockImplementation((_cols: string, opts?: { count?: string; head?: boolean }) => {
        // 第一个 select 之后的链路根据 status 区分
        return {
          eq: vi.fn().mockImplementation((_col: string, status: string) => {
            if (table !== 'sync_tasks') return {};

            if (status === 'pending') {
              // pending 查询有两种：一是带 count 的取 attempts 列表（pendingResult），
              // 二是再次 eq 后 order limit 取最早一条（oldestPendingResult）
              if (opts?.count === 'exact' && !opts.head) {
                return Promise.resolve({
                  data: mockPendingRows,
                  count: mockPendingRows.length,
                  error: mockPendingError,
                });
              }
              // oldest pending：链上还有 order().limit().maybeSingle()
              return {
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: mockOldestPending,
                      error: null,
                    }),
                  }),
                }),
              };
            }
            if (status === 'processing') {
              return Promise.resolve({ count: mockProcessingCount, error: null });
            }
            if (status === 'dead') {
              return Promise.resolve({ count: mockDeadCount, error: null });
            }
            return Promise.resolve({ data: null, count: 0, error: null });
          }),
        };
      }),
  };
}

vi.mock('../../lib/supabase.js', () => ({
  getSupabaseClient: vi.fn(() => ({
    schema: vi.fn().mockReturnValue({
      from: vi.fn().mockImplementation(createSelectChain),
    }),
  })),
}));

import { getQueueMetrics } from '../metrics.js';

// ─── 测试 ──────────────────────────────────────────────────────────────────

describe('getQueueMetrics()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPendingRows = [];
    mockProcessingCount = 0;
    mockDeadCount = 0;
    mockOldestPending = null;
    mockPendingError = null;
  });

  it('空队列返回全 0 + oldest_pending_age_ms=null', async () => {
    const metrics = await getQueueMetrics();

    expect(metrics.pending).toBe(0);
    expect(metrics.processing).toBe(0);
    expect(metrics.failed).toBe(0);
    expect(metrics.dead).toBe(0);
    expect(metrics.oldest_pending_age_ms).toBeNull();
  });

  it('区分 pending（attempts=0） vs failed（attempts>0）', async () => {
    mockPendingRows = [
      { attempts: 0 },
      { attempts: 0 },
      { attempts: 0 },
      { attempts: 1 },
      { attempts: 3 },
    ];

    const metrics = await getQueueMetrics();
    expect(metrics.pending).toBe(3);
    expect(metrics.failed).toBe(2);
  });

  it('processing/dead 数从 count 取', async () => {
    mockProcessingCount = 2;
    mockDeadCount = 5;

    const metrics = await getQueueMetrics();
    expect(metrics.processing).toBe(2);
    expect(metrics.dead).toBe(5);
  });

  it('oldest_pending_age_ms 按 created_at 计算', async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockOldestPending = { created_at: fiveMinAgo };

    const metrics = await getQueueMetrics();

    expect(metrics.oldest_pending_age_ms).not.toBeNull();
    // 允许误差 1s
    expect(metrics.oldest_pending_age_ms!).toBeGreaterThan(5 * 60 * 1000 - 1000);
    expect(metrics.oldest_pending_age_ms!).toBeLessThan(5 * 60 * 1000 + 1000);
  });

  it('pending 查询失败时返回默认值，不抛错', async () => {
    mockPendingError = { message: 'connection refused' };

    // 不应抛错
    const metrics = await getQueueMetrics();
    expect(metrics.pending).toBe(0);
    expect(metrics.failed).toBe(0);
  });
});
