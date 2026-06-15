/**
 * sync-engine / queue / types.ts
 *
 * 任务队列的类型定义。
 * 状态机：pending → processing → completed
 *                              → failed → (retry) → pending
 *                                       → (max_attempts) → dead
 */

// ─── 任务状态 ────────────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'dead';

// ─── 任务类型（阶段一只有 settings_up） ──────────────────────────────────────

export type TaskType = 'settings_up';

// ─── 数据库行 ────────────────────────────────────────────────────────────────

export interface SyncTaskRow {
  id: string;
  user_id: string;
  handle: string;
  task_type: TaskType;
  status: TaskStatus;
  attempts: number;
  max_attempts: number;
  next_retry_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// ─── 入队参数 ────────────────────────────────────────────────────────────────

export interface EnqueueParams {
  userId: string;
  handle: string;
  taskType?: TaskType;
}

// ─── 消费结果 ────────────────────────────────────────────────────────────────

export interface ConsumeResult {
  /** 本轮消费了多少个任务 */
  processed: number;
  /** 其中成功的 */
  succeeded: number;
  /** 其中失败并进入重试的 */
  retried: number;
  /** 其中进入死信的 */
  dead: number;
}
