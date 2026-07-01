/**
 * queue / __tests__ / consumer.test.ts
 *
 * Consumer 消费逻辑单元测试，vi.mock 隔离 Supabase + uploader。
 *
 * 测试重点：
 *   1. 正常消费：pending → processing → completed
 *   2. 失败重试：pending → processing → failed(pending) → 下次轮询重新消费
 *   3. 死信：重试耗尽 → dead
 *   4. 乐观锁：领取失败（已被抢走）→ 安全跳过
 *   5. 空队列：无 pending 任务 → 不调用 uploadSettings
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock uploadSettings ────────────────────────────────────────────────────
const mockUploadSettings = vi.fn();

vi.mock('../../watcher/uploader.js', () => ({
  uploadSettings: (...args: unknown[]) => mockUploadSettings(...args),
}));

// ─── Mock config ────────────────────────────────────────────────────────────
vi.mock('../../lib/config.js', () => ({
  config: {
    ST_DATA_PATH: '/mock-st-data',
    SUPABASE_URL: 'https://mock.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'mock-key',
    ST_BASE_URL: 'http://localhost:8000',
    ST_ADMIN_USERNAME: 'admin',
    ST_ADMIN_PASSWORD: 'pass',
    ST_USER_PASSWORD_SECRET: 'mock-secret-at-least-16',
  },
  loadConfig: vi.fn(),
}));

// ─── Mock Supabase 客户端 ───────────────────────────────────────────────────

let mockPendingTasks: Record<string, unknown>[] = [];
let mockClaimResult: { data: unknown; error: unknown } = { data: { id: 'task-1' }, error: null };
const mockUpdate = vi.fn();

function createMockFrom(table: string) {
  if (table === 'sync_tasks') {
    return {
      select: vi.fn().mockImplementation(() => ({
        eq: vi.fn().mockImplementation(() => ({
          lte: vi.fn().mockImplementation(() => ({
            order: vi.fn().mockImplementation(() => ({
              limit: vi.fn().mockResolvedValue({ data: mockPendingTasks, error: null }),
            })),
          })),
        })),
      })),
      update: vi.fn().mockImplementation((payload: unknown) => {
        mockUpdate(payload);
        return {
          eq: vi.fn().mockImplementation(() => ({
            eq: vi.fn().mockImplementation(() => ({
              select: vi.fn().mockImplementation(() => ({
                maybeSingle: vi.fn().mockResolvedValue(mockClaimResult),
              })),
            })),
          })),
        };
      }),
    };
  }
  return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
}

vi.mock('../../lib/supabase.js', () => ({
  getSupabaseClient: vi.fn(() => ({
    schema: vi.fn().mockReturnValue({
      from: vi.fn().mockImplementation(createMockFrom),
    }),
  })),
}));

// ─── 在 mock 之后 import ───────────────────────────────────────────────────
import { Consumer } from '../consumer.js';

// ─── 测试固件 ──────────────────────────────────────────────────────────────

const TASK_1 = {
  id: 'task-0001',
  user_id: 'user-0001',
  handle: 'tg_111',
  task_type: 'settings_up',
  status: 'pending',
  attempts: 0,
  max_attempts: 5,
  next_retry_at: new Date().toISOString(),
  last_error: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// ─── 测试套件 ──────────────────────────────────────────────────────────────

describe('Consumer', () => {
  let consumer: Consumer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPendingTasks = [];
    mockClaimResult = { data: { id: 'task-0001' }, error: null };
    mockUploadSettings.mockResolvedValue({ skipped: false, revision: 1, contentHash: 'abc' });
    consumer = new Consumer();
  });

  afterEach(async () => {
    await consumer.stop();
  });

  // ── 场景 1：正常消费 ──────────────────────────────────────────────────

  it('pending 任务被消费后调用 uploadSettings', async () => {
    mockPendingTasks = [{ ...TASK_1 }];

    await consumer.start();
    // start() 内部会立即 poll 一次

    // 等待异步任务完成
    await new Promise((r) => setTimeout(r, 100));

    expect(mockUploadSettings).toHaveBeenCalledOnce();
    expect(mockUploadSettings).toHaveBeenCalledWith('user-0001', 'tg_111');
  });

  it('成功后 update 状态为 completed', async () => {
    mockPendingTasks = [{ ...TASK_1 }];

    await consumer.start();
    await new Promise((r) => setTimeout(r, 100));

    // mockUpdate 应被调用多次：一次 processing，一次 completed
    const updateCalls = mockUpdate.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(updateCalls.some((c) => c.status === 'processing')).toBe(true);
    expect(updateCalls.some((c) => c.status === 'completed')).toBe(true);
  });

  // ── 场景 2：失败 → 重试 ───────────────────────────────────────────────

  it('uploadSettings 失败时 update 状态回 pending 并设置 next_retry_at', async () => {
    mockPendingTasks = [{ ...TASK_1 }];
    mockUploadSettings.mockRejectedValue(new Error('network timeout'));

    await consumer.start();
    await new Promise((r) => setTimeout(r, 100));

    const updateCalls = mockUpdate.mock.calls.map((c) => c[0] as Record<string, unknown>);
    // 失败后应标回 pending（重试）
    const retryUpdate = updateCalls.find(
      (c) => c.status === 'pending' && (c.attempts as number) === 1
    );
    expect(retryUpdate).toBeDefined();
    expect(retryUpdate!.last_error).toContain('network timeout');
    expect(retryUpdate!.next_retry_at).toBeDefined();
  });

  // ── 场景 3：重试耗尽 → 死信 ───────────────────────────────────────────

  it('attempts 达到 max_attempts 时标记为 dead', async () => {
    mockPendingTasks = [{ ...TASK_1, attempts: 4, max_attempts: 5 }];
    mockUploadSettings.mockRejectedValue(new Error('persistent failure'));

    await consumer.start();
    await new Promise((r) => setTimeout(r, 100));

    const updateCalls = mockUpdate.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const deadUpdate = updateCalls.find((c) => c.status === 'dead');
    expect(deadUpdate).toBeDefined();
    expect(deadUpdate!.attempts).toBe(5);
  });

  // ── 场景 4：乐观锁领取失败 ─────────────────────────────────────────────

  it('领取失败（已被抢走）→ 不调用 uploadSettings', async () => {
    mockPendingTasks = [{ ...TASK_1 }];
    mockClaimResult = { data: null, error: null }; // 领取返回 null = 已被抢

    await consumer.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(mockUploadSettings).not.toHaveBeenCalled();
  });

  // ── 场景 5：空队列 ────────────────────────────────────────────────────

  it('无 pending 任务时不调用 uploadSettings', async () => {
    mockPendingTasks = [];

    await consumer.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(mockUploadSettings).not.toHaveBeenCalled();
  });

  // ── 场景 6：nudge 触发即时消费 ─────────────────────────────────────────

  it('nudge() 触发一次即时轮询', async () => {
    mockPendingTasks = [];
    await consumer.start();

    // 第一次 poll（start 内部）无任务
    expect(mockUploadSettings).not.toHaveBeenCalled();

    // 模拟入队后有新任务
    mockPendingTasks = [{ ...TASK_1, id: 'task-nudge' }];
    mockClaimResult = { data: { id: 'task-nudge' }, error: null };
    consumer.nudge();

    await new Promise((r) => setTimeout(r, 100));
    expect(mockUploadSettings).toHaveBeenCalledOnce();
  });
});
