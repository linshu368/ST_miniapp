/**
 * sync-engine / queue / consumer.ts
 *
 * 任务消费器。
 * 职责：
 *   1. 轮询 st_infra.sync_tasks 取 pending 且 next_retry_at <= now() 的任务
 *   2. 乐观锁领取（pending → processing）
 *   3. 调用 uploadSettings() 执行实际同步
 *   4. 成功 → completed；失败 → computeRetry 决定 retry 或 dead
 *
 * 决策 2（已确认）：per-handle 串行——
 *   不同 handle 的任务可并行，同 handle 的严格串行（内存锁）。
 *   防止同用户的 user_revision 并发冲突。
 */

import { EventEmitter } from 'node:events';
import { getSupabaseClient } from '../lib/supabase.js';
import { uploadSettings } from '../watcher/uploader.js';
import { createLogger } from '../lib/logger.js';
import { computeRetry } from './retry.js';
import type { SyncTaskRow, ConsumeResult } from './types.js';

const logger = createLogger('consumer');

// ─── 配置常量 ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 10_000;
const BATCH_SIZE = 20;

// ─── per-handle 串行锁 ──────────────────────────────────────────────────────
// 值为当前正在执行的 Promise；同 handle 新任务需 await 前一个完成
const handleLocks = new Map<string, Promise<void>>();

function withHandleLock(handle: string, fn: () => Promise<void>): Promise<void> {
  const prev = handleLocks.get(handle) ?? Promise.resolve();
  const next = prev.then(fn, fn); // 前一个无论成功失败都执行下一个
  handleLocks.set(handle, next);
  // 清理：当链条完成时移除锁（避免内存泄漏）
  next.finally(() => {
    if (handleLocks.get(handle) === next) {
      handleLocks.delete(handle);
    }
  });
  return next;
}

// ─── 消费器类 ────────────────────────────────────────────────────────────────

export class Consumer {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private emitter = new EventEmitter();

  /**
   * 启动消费器：
   *   1. 立即扫描一次残留任务（进程重启恢复）
   *   2. 启动兜底轮询
   *   3. 监听 'nudge' 信号（file-watcher 入队后通知立即消费）
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    logger.info('启动消费器...');

    // 启动时先扫一次残留任务
    await this.poll();

    // 兜底轮询
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => {
        logger.error({ err: String(err) }, '轮询出错');
      });
    }, POLL_INTERVAL_MS);

    // 信号驱动：入队后立即消费
    this.emitter.on('nudge', () => {
      this.poll().catch((err) => {
        logger.error({ err: String(err) }, 'nudge 触发消费出错');
      });
    });

    logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, '消费器已启动');
  }

  /** file-watcher 入队后调用，通知 consumer 立即取任务 */
  nudge(): void {
    this.emitter.emit('nudge');
  }

  /** 优雅停止：停轮询 + 等待所有 handle 锁释放 */
  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.emitter.removeAllListeners();

    // 等待所有进行中的任务完成
    const pending = [...handleLocks.values()];
    if (pending.length > 0) {
      logger.info({ count: pending.length }, '等待进行中的任务完成');
      await Promise.allSettled(pending);
    }

    logger.info('消费器已停止');
  }

  // ─── 轮询核心 ──────────────────────────────────────────────────────────

  private async poll(): Promise<ConsumeResult> {
    if (!this.running) return { processed: 0, succeeded: 0, retried: 0, dead: 0 };

    const db = getSupabaseClient();

    // 取一批 pending 且到期的任务
    const { data: tasks, error } = await db
      .schema('st_infra')
      .from('sync_tasks')
      .select('*')
      .eq('status', 'pending')
      .lte('next_retry_at', new Date().toISOString())
      .order('next_retry_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (error) {
      logger.error({ err: error.message }, '查询 pending 任务失败');
      return { processed: 0, succeeded: 0, retried: 0, dead: 0 };
    }

    const rows = (tasks ?? []) as SyncTaskRow[];
    if (rows.length === 0) return { processed: 0, succeeded: 0, retried: 0, dead: 0 };

    logger.info({ count: rows.length }, '取到待处理任务');

    const result: ConsumeResult = { processed: 0, succeeded: 0, retried: 0, dead: 0 };

    // per-handle 串行分发
    const taskPromises = rows.map((task) =>
      withHandleLock(task.handle, async () => {
        const outcome = await this.processTask(task);
        result.processed++;
        if (outcome === 'completed') result.succeeded++;
        else if (outcome === 'retried') result.retried++;
        else if (outcome === 'dead') result.dead++;
      })
    );

    await Promise.allSettled(taskPromises);
    return result;
  }

  // ─── 单任务处理 ────────────────────────────────────────────────────────

  private async processTask(task: SyncTaskRow): Promise<'completed' | 'retried' | 'dead'> {
    const db = getSupabaseClient();
    const log = logger.child({ taskId: task.id, handle: task.handle });

    // 乐观锁领取：pending → processing（防止并发消费者取同一任务）
    const { data: claimed, error: claimErr } = await db
      .schema('st_infra')
      .from('sync_tasks')
      .update({ status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', task.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();

    if (claimErr || !claimed) {
      log.warn('任务领取失败（已被其他消费者抢走或状态已变）');
      return 'completed'; // 不计入失败
    }

    // 执行实际同步
    const newAttempts = task.attempts + 1;
    try {
      await uploadSettings(task.user_id, task.handle);

      // 成功 → completed
      await db
        .schema('st_infra')
        .from('sync_tasks')
        .update({
          status: 'completed',
          attempts: newAttempts,
          updated_at: new Date().toISOString(),
        })
        .eq('id', task.id);

      log.info('任务完成');
      return 'completed';
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error({ err: errorMsg, attempt: newAttempts }, '任务失败');

      // 计算重试策略
      const decision = computeRetry(newAttempts, task.max_attempts);

      if (decision.shouldRetry) {
        await db
          .schema('st_infra')
          .from('sync_tasks')
          .update({
            status: 'pending',
            attempts: newAttempts,
            next_retry_at: decision.nextRetryAt!.toISOString(),
            last_error: errorMsg,
            updated_at: new Date().toISOString(),
          })
          .eq('id', task.id);

        log.warn(
          {
            attempt: newAttempts,
            maxAttempts: task.max_attempts,
            delayMs: decision.delayMs,
          },
          '任务将稍后重试'
        );
        return 'retried';
      } else {
        // 死信
        await db
          .schema('st_infra')
          .from('sync_tasks')
          .update({
            status: 'dead',
            attempts: newAttempts,
            last_error: errorMsg,
            updated_at: new Date().toISOString(),
          })
          .eq('id', task.id);

        log.error({ attempts: newAttempts }, '任务进入死信');
        return 'dead';
      }
    }
  }
}
