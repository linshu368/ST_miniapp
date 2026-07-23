/**
 * sync-engine / queue / metrics.ts
 *
 * 队列指标查询。
 * 健康监控接口的数据源。
 */

import { getSupabaseClient } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('metrics');

export interface QueueMetrics {
  /** 待消费数（pending 且 attempts=0） */
  pending: number;
  /** 进行中 */
  processing: number;
  /** 重试中（pending 且 attempts > 0） */
  failed: number;
  /** 死信 */
  dead: number;
  /** 最早 pending 任务的等待时长（毫秒），无 pending 时为 null */
  oldest_pending_age_ms: number | null;
}

/**
 * 查询当前队列指标。
 * 失败时返回安全默认值（不抛错，避免健康检查级联失败）。
 */
export async function getQueueMetrics(): Promise<QueueMetrics> {
  const db = getSupabaseClient();
  const defaultMetrics: QueueMetrics = {
    pending: 0,
    processing: 0,
    failed: 0,
    dead: 0,
    oldest_pending_age_ms: null,
  };

  try {
    // 并行拉所有状态的任务（只取需要的字段）
    const [pendingResult, processingResult, deadResult, oldestPendingResult] = await Promise.all([
      db
        .schema('st_infra')
        .from('sync_tasks')
        .select('attempts', { count: 'exact' })
        .eq('status', 'pending'),
      db
        .schema('st_infra')
        .from('sync_tasks')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'processing'),
      db
        .schema('st_infra')
        .from('sync_tasks')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'dead'),
      db
        .schema('st_infra')
        .from('sync_tasks')
        .select('created_at')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);

    // pending 数据需要细分 attempts 区分 pending 和 failed
    let pending = 0;
    let failed = 0;
    if (pendingResult.error) {
      logger.sys.warn(
        { event: 'metrics.query_pending.failed', err: pendingResult.error },
        '查询 pending 失败'
      );
    } else {
      for (const row of pendingResult.data ?? []) {
        const r = row as { attempts: number };
        if (r.attempts === 0) pending++;
        else failed++;
      }
    }

    const processing = processingResult.count ?? 0;
    const dead = deadResult.count ?? 0;

    let oldest_pending_age_ms: number | null = null;
    if (oldestPendingResult.data) {
      const createdAt = (oldestPendingResult.data as { created_at: string }).created_at;
      oldest_pending_age_ms = Date.now() - new Date(createdAt).getTime();
    }

    return { pending, processing, failed, dead, oldest_pending_age_ms };
  } catch (err) {
    logger.sys.error({ event: 'metrics.query.failed', err }, 'getQueueMetrics 异常');
    return defaultMetrics;
  }
}
