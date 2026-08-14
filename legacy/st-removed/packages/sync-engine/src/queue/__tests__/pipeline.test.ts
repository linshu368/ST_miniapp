/**
 * queue / __tests__ / pipeline.test.ts
 *
 * 端到端集成测试：producer.enqueue → Consumer.poll → uploadSettings → 状态更新。
 *
 * 用 in-memory 的 fake sync_tasks 表（数组）让 producer 和 consumer 共享状态，
 * 跳过 file-watcher 层（已有单元测试覆盖），uploadSettings 被 mock 以验证调用。
 *
 * 测试重点：
 *   1. 完整链路：入队 → 消费 → 完成（status=completed）
 *   2. 失败重试：入队 → 消费失败 → 状态回 pending + attempts 增加
 *   3. 死信：attempts 达到 max → status=dead
 *   4. 同 handle 防重复入队
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock config ────────────────────────────────────────────────────────────
vi.mock('../../lib/config.js', () => ({
  config: {
    SUPABASE_URL: 'https://mock.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'mock-key',
    ST_DATA_PATH: '/mock',
    ST_BASE_URL: 'http://localhost:8000',
    ST_ADMIN_USERNAME: 'admin',
    ST_ADMIN_PASSWORD: 'pass',
    ST_USER_PASSWORD_SECRET: 'mock-secret-at-least-16',
    HEALTH_PORT: 0,
  },
  loadConfig: vi.fn(),
}));

// ─── Mock uploadSettings ────────────────────────────────────────────────────
const mockUploadSettings = vi.fn();

vi.mock('../../watcher/uploader.js', () => ({
  uploadSettings: (...args: unknown[]) => mockUploadSettings(...args),
}));

// ─── In-memory sync_tasks 表 + fake Supabase 客户端 ─────────────────────────

interface FakeTaskRow {
  id: string;
  user_id: string;
  handle: string;
  task_type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_retry_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

let table: FakeTaskRow[] = [];
let nextId = 1;

function genId(): string {
  return `task-${String(nextId++).padStart(4, '0')}`;
}

// 构造一个 fake supabase 客户端，仅支持 producer/consumer 使用的查询模式
function createFakeSupabase() {
  return {
    schema: () => ({
      from: (tableName: string) => {
        if (tableName !== 'sync_tasks') throw new Error('unexpected table: ' + tableName);
        return buildSyncTasksBuilder();
      },
    }),
  };
}

interface QueryState {
  filters: Array<{ col: string; op: 'eq' | 'lte' | 'in'; val: unknown }>;
  orderBy: { col: string; asc: boolean } | null;
  limitN: number | null;
  selectCols: string | null;
  updatePatch: Record<string, unknown> | null;
  insertRow: Record<string, unknown> | null;
}

function applyFilters(rows: FakeTaskRow[], filters: QueryState['filters']): FakeTaskRow[] {
  return rows.filter((r) => {
    for (const f of filters) {
      const v = (r as unknown as Record<string, unknown>)[f.col];
      if (f.op === 'eq' && v !== f.val) return false;
      if (f.op === 'lte' && typeof v === 'string' && typeof f.val === 'string' && v > f.val)
        return false;
      if (f.op === 'in' && Array.isArray(f.val) && !f.val.includes(v)) return false;
    }
    return true;
  });
}

function buildSyncTasksBuilder() {
  const state: QueryState = {
    filters: [],
    orderBy: null,
    limitN: null,
    selectCols: null,
    updatePatch: null,
    insertRow: null,
  };

  const builder: Record<string, unknown> = {};

  builder.select = (cols: string) => {
    state.selectCols = cols;
    return builder;
  };

  builder.eq = (col: string, val: unknown) => {
    state.filters.push({ col, op: 'eq', val });
    return builder;
  };

  builder.lte = (col: string, val: unknown) => {
    state.filters.push({ col, op: 'lte', val });
    return builder;
  };

  builder.in = (col: string, val: unknown[]) => {
    state.filters.push({ col, op: 'in', val });
    return builder;
  };

  builder.order = (col: string, opts?: { ascending?: boolean }) => {
    state.orderBy = { col, asc: opts?.ascending !== false };
    return builder;
  };

  builder.limit = (n: number) => {
    state.limitN = n;
    return builder;
  };

  builder.insert = (row: Record<string, unknown>) => {
    state.insertRow = row;
    return builder;
  };

  builder.update = (patch: Record<string, unknown>) => {
    state.updatePatch = patch;
    return builder;
  };

  function executeRead(): { data: FakeTaskRow[]; error: null } {
    let rows = applyFilters(table, state.filters);
    if (state.orderBy) {
      const { col, asc } = state.orderBy;
      rows = [...rows].sort((a, b) => {
        const av = (a as unknown as Record<string, unknown>)[col] as string;
        const bv = (b as unknown as Record<string, unknown>)[col] as string;
        if (av < bv) return asc ? -1 : 1;
        if (av > bv) return asc ? 1 : -1;
        return 0;
      });
    }
    if (state.limitN !== null) rows = rows.slice(0, state.limitN);
    return { data: rows, error: null };
  }

  builder.single = async () => {
    const { data } = executeRead();
    if (data.length === 0) return { data: null, error: { message: 'no rows' } };
    return { data: data[0], error: null };
  };

  builder.maybeSingle = async () => {
    if (state.updatePatch) {
      // update().eq().eq().select().maybeSingle() —— 这是 claim 模式
      const matched = applyFilters(table, state.filters);
      if (matched.length === 0) return { data: null, error: null };
      for (const row of matched) {
        Object.assign(row, state.updatePatch);
      }
      return { data: { id: matched[0]!.id }, error: null };
    }
    const { data } = executeRead();
    return { data: data[0] ?? null, error: null };
  };

  // insert(...).select(...).single()
  builder.then = undefined; // ensure not thenable

  // 触发执行的链路有：
  //   await builder（select 查询、update 无 select 后链）
  //   await builder.single() / maybeSingle()
  //   await builder.select(...).single() / single() (insert 后)

  // 处理 insert
  const originalSelect = builder.select as (cols: string) => Record<string, unknown>;
  builder.select = (cols: string) => {
    if (state.insertRow) {
      // insert chain
      const row: FakeTaskRow = {
        id: genId(),
        user_id: state.insertRow.user_id as string,
        handle: state.insertRow.handle as string,
        task_type: (state.insertRow.task_type as string) ?? 'settings_up',
        status: (state.insertRow.status as string) ?? 'pending',
        attempts: (state.insertRow.attempts as number) ?? 0,
        max_attempts: (state.insertRow.max_attempts as number) ?? 5,
        next_retry_at: (state.insertRow.next_retry_at as string) ?? new Date().toISOString(),
        last_error: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      table.push(row);
      // 后续 .single() 返回这一行
      return {
        single: async () => ({ data: { id: row.id }, error: null }),
      };
    }
    return originalSelect(cols);
  };

  // 处理 await builder 直接执行（无 single/maybeSingle）的场景
  // update().eq() 之后 await：需要把 update 应用到匹配行
  const promiseLike = {
    then: (resolve: (val: { data: FakeTaskRow[] | null; error: null }) => void) => {
      if (state.updatePatch) {
        const matched = applyFilters(table, state.filters);
        for (const row of matched) {
          Object.assign(row, state.updatePatch);
        }
        resolve({ data: null, error: null });
      } else {
        resolve(executeRead());
      }
    },
  };
  // 让 builder 自身可被 await
  (builder as Record<string, unknown>).then = promiseLike.then;

  return builder;
}

vi.mock('../../lib/supabase.js', () => ({
  getSupabaseClient: () => createFakeSupabase(),
}));

// ─── 在 mock 之后 import ───────────────────────────────────────────────────
import { enqueue } from '../producer.js';
import { Consumer } from '../consumer.js';

// ─── 测试 ──────────────────────────────────────────────────────────────────

describe('Pipeline: enqueue → consume → upload', () => {
  let consumer: Consumer;

  beforeEach(() => {
    table = [];
    nextId = 1;
    vi.clearAllMocks();
    consumer = new Consumer();
  });

  afterEach(async () => {
    await consumer.stop();
  });

  it('完整成功链路：enqueue 后 consumer 消费成功，状态变 completed', async () => {
    mockUploadSettings.mockResolvedValue({ skipped: false, revision: 1, contentHash: 'abc' });

    const result = await enqueue({ userId: 'user-1', handle: 'tg_111' });
    expect(result.enqueued).toBe(true);
    expect(table).toHaveLength(1);
    expect(table[0]!.status).toBe('pending');

    await consumer.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(mockUploadSettings).toHaveBeenCalledWith('user-1', 'tg_111');
    expect(table[0]!.status).toBe('completed');
    expect(table[0]!.attempts).toBe(1);
  });

  it('失败重试链路：upload 失败 → 任务回 pending，attempts=1，next_retry_at 在未来', async () => {
    mockUploadSettings.mockRejectedValue(new Error('network down'));

    await enqueue({ userId: 'user-1', handle: 'tg_222' });

    await consumer.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(table[0]!.status).toBe('pending');
    expect(table[0]!.attempts).toBe(1);
    expect(table[0]!.last_error).toContain('network down');
    expect(new Date(table[0]!.next_retry_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('死信链路：attempts=4 时再次失败 → status=dead', async () => {
    // 预置一个已失败 4 次的任务
    table.push({
      id: genId(),
      user_id: 'user-1',
      handle: 'tg_333',
      task_type: 'settings_up',
      status: 'pending',
      attempts: 4,
      max_attempts: 5,
      next_retry_at: new Date(Date.now() - 1000).toISOString(), // 到期可消费
      last_error: 'previous failures',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    mockUploadSettings.mockRejectedValue(new Error('still failing'));

    await consumer.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(table[0]!.status).toBe('dead');
    expect(table[0]!.attempts).toBe(5);
  });

  it('同 handle 防重复：第一个 pending 未消费时，第二个入队跳过', async () => {
    const r1 = await enqueue({ userId: 'user-1', handle: 'tg_444' });
    expect(r1.enqueued).toBe(true);

    const r2 = await enqueue({ userId: 'user-1', handle: 'tg_444' });
    expect(r2.enqueued).toBe(false);
    expect(r2.taskId).toBeNull();

    expect(table).toHaveLength(1);
  });

  it('不同 handle 不互相阻塞', async () => {
    await enqueue({ userId: 'user-1', handle: 'tg_aaa' });
    await enqueue({ userId: 'user-2', handle: 'tg_bbb' });

    expect(table).toHaveLength(2);
    expect(table.every((t) => t.status === 'pending')).toBe(true);
  });
});
