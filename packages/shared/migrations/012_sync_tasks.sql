-- 012: 同步引擎任务队列（持久化）
--
-- 归属：st_infra schema（同步引擎基建，D014 三 schema 切分后独立于 A/B 区）
-- 用途：反向同步任务的入队、消费、重试、死信追踪
--
-- 决策依据：
--   - D6 里程碑：用 Supabase 表做持久化队列
--   - 决策 1：放 shared/migrations 统一管理，沿用 D009 minimal RLS
--   - 决策 3：同 handle 防重复入队（producer 入队前检查 pending 状态）
--   - 决策 4：死信同表标记 status='dead'，不单独建表
--
-- 状态机：
--   pending → processing → completed
--                       → failed → (retry) → pending
--                                → (max_attempts) → dead

CREATE TABLE IF NOT EXISTS st_infra.sync_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ─── 任务归属 ────────────────────────────────────────────────────────
  user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  handle          TEXT NOT NULL,

  -- 任务类型（阶段一只有 settings_up；未来可扩展 chats_up 等）
  task_type       TEXT NOT NULL DEFAULT 'settings_up',

  -- ─── 状态机 ──────────────────────────────────────────────────────────
  -- pending    : 等待消费
  -- processing : 正在执行（防止并发取同一任务）
  -- completed  : 执行成功
  -- failed     : 本次执行失败，等待重试（下次轮询 next_retry_at <= now() 时重新变为 pending 消费）
  -- dead       : 超过最大重试次数，人工介入
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead')),

  -- ─── 重试追踪 ────────────────────────────────────────────────────────
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  -- 下次可被消费的时间（指数退避：5s * 2^(attempt-1)）
  next_retry_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 最近一次失败的错误信息
  last_error      TEXT,

  -- ─── 元数据 ──────────────────────────────────────────────────────────
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 索引 ──────────────────────────────────────────────────────────────
-- 消费者轮询用：取 status=pending 且 next_retry_at <= now() 的任务
CREATE INDEX IF NOT EXISTS idx_sync_tasks_pending
  ON st_infra.sync_tasks(next_retry_at ASC)
  WHERE status = 'pending';

-- 入队防重复用：检查同 handle 是否已有 pending/processing 任务
CREATE INDEX IF NOT EXISTS idx_sync_tasks_handle_active
  ON st_infra.sync_tasks(handle)
  WHERE status IN ('pending', 'processing');

-- ─── RLS（沿用 D009 minimal 模式） ──────────────────────────────────────
ALTER TABLE st_infra.sync_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON st_infra.sync_tasks FROM anon, authenticated;
GRANT ALL ON st_infra.sync_tasks TO service_role;

-- ─── 注释 ──────────────────────────────────────────────────────────────
COMMENT ON TABLE st_infra.sync_tasks IS
  '[partition=infra][shape=queue][direction=internal] '
  '同步引擎任务队列。反向同步任务的持久化入队、消费、重试、死信追踪。'
  'service_role 唯一可访问（D009 minimal 模式）';
