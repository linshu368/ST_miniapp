/**
 * sync-engine / queue / producer.ts
 *
 * 入队逻辑。
 * 决策 3（已确认）：同 handle 防重复入队——
 *   入队前检查该 handle 是否已有 pending/processing 任务，
 *   有则跳过（consumer 执行时读的是当时最新的文件内容，老任务自然覆盖）。
 */

import { getSupabaseClient } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
import type { EnqueueParams, TaskStatus } from './types.js';

const logger = createLogger('producer');

export interface EnqueueResult {
  /** true = 成功入队；false = 已有活跃任务，跳过 */
  enqueued: boolean;
  /** 入队的任务 id（跳过时为 null） */
  taskId: string | null;
}

/**
 * 将一个反向同步任务入队。
 * 同 handle 防重复：若该 handle 已有 pending/processing 状态的任务，跳过入队。
 */
export async function enqueue(params: EnqueueParams): Promise<EnqueueResult> {
  const { userId, handle, taskType = 'settings_up' } = params;
  const db = getSupabaseClient();
  const log = logger.child({ handle, userId });

  // 检查同 handle 是否已有活跃任务
  const activeStatuses: TaskStatus[] = ['pending', 'processing'];
  const { data: existing, error: checkErr } = await db
    .schema('st_infra')
    .from('sync_tasks')
    .select('id')
    .eq('handle', handle)
    .in('status', activeStatuses)
    .limit(1)
    .maybeSingle();

  if (checkErr) {
    log.warn({ err: checkErr.message }, '检查活跃任务失败');
    // 检查失败不阻塞入队——宁可多入一个任务，也不丢变更
  } else if (existing) {
    const existingId = (existing as { id: string }).id;
    log.info({ existingTaskId: existingId }, '已有活跃任务，跳过入队');
    return { enqueued: false, taskId: null };
  }

  // 入队
  const { data: inserted, error: insertErr } = await db
    .schema('st_infra')
    .from('sync_tasks')
    .insert({
      user_id: userId,
      handle,
      task_type: taskType,
      status: 'pending',
      attempts: 0,
      next_retry_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (insertErr) {
    log.error({ err: insertErr.message }, '入队失败');
    throw new Error(`入队失败：${insertErr.message}`);
  }

  const taskId = (inserted as { id: string }).id;
  log.info({ taskId }, '入队成功');
  return { enqueued: true, taskId };
}
