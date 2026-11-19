import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/db.js';
import type { Logger } from '../../lib/logger.js';
import { FeishuAlertSink } from './feishu-alert-sink.js';
import { readAlertingRuntimeConfig, type AlertingRuntimeConfig } from './runtime-config.js';
import type { SafeAlertCard } from './safe-card.js';
import { backoffMs } from './semantics.js';

/**
 * 支付域的 P1 与恢复通知关闭；已注释的旧 P0 即使还在队列里也不再发送。
 * 体验监控（domain=experience）不走这套抑制：卡顿/卡住本就是 P1，压掉等于不告警。
 * 模型供应商（domain=generation）的限流与账户阻断也不抑制，否则 P1 429 永远不会通知。
 * Sentry 转发来的告警同样不走：它们是用户侧已经在发生的事实，
 * 而且 5xx 比例这类规则天然就是 P1；压掉会让整套体验监控形同不存在。
 */
function feishuNotificationSuppressed(card: SafeAlertCard): boolean {
  const fingerprint = card.incident_fingerprint;
  // Only this dedicated synthetic rule opts into P1 and recovery; keep old payment rules intact.
  if (
    typeof fingerprint === 'string' &&
    /^(?:development|test|preview|production):payment:upstream-create-probe:(?:alipay|wxpay)$/.test(
      fingerprint
    )
  )
    return false;
  const isExperience = typeof fingerprint === 'string' && fingerprint.includes(':experience:');
  const isFromSentry = typeof fingerprint === 'string' && fingerprint.includes(':sentry:');
  const isGeneration = typeof fingerprint === 'string' && fingerprint.includes(':generation:');
  // 体验/Sentry/generation 域连恢复都要发——没有恢复通知会让事故长期保持未确认状态。
  if (isExperience || isFromSentry || isGeneration) return false;
  if (card.transition === 'recovered' || card.severity === 'P1') return true;
  return (
    typeof card.incident_fingerprint === 'string' &&
    /:payment:p0-0[1-5]:all$/.test(card.incident_fingerprint)
  );
}

type DeliveryRow = {
  id: bigint;
  notification_key: string;
  payload: unknown;
  attempt_count: number;
};

type DeliveryResult = 'disabled' | 'idle' | 'sent' | 'retrying' | 'abandoned';

/** 每轮上限：最长约 10 ×（投递间隔 + 飞书超时），要小于 monitor 的 60s 轮次间隔，且低于飞书机器人限流。 */
const DELIVERY_BATCH_LIMIT = 10;
/** 投递间隔被配置得很长时直接结束本轮，不在 advisory lock 里睡眠，下一轮再继续。 */
const MAX_IN_ROUND_WAIT_MS = 5_000;

export class AlertDeliveryWorker {
  private nextAllowedAt = 0;

  constructor(
    private readonly sink: FeishuAlertSink,
    private readonly log: Pick<Logger, 'biz' | 'sys'>,
    private readonly readConfig: () => Promise<AlertingRuntimeConfig> = readAlertingRuntimeConfig,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  /** One monitor round: collapse stale duplicates, then drain up to the batch limit. */
  async deliverBatch(limit = DELIVERY_BATCH_LIMIT): Promise<number> {
    const config = await this.readConfig();
    if (!config.notifications_enabled) return 0;
    await this.supersedeStale();
    let delivered = 0;
    for (let index = 0; index < limit; index += 1) {
      const wait = this.nextAllowedAt - Date.now();
      if (wait > MAX_IN_ROUND_WAIT_MS) break;
      if (wait > 0) await this.sleep(wait);
      const result = await this.deliverClaimed(config);
      if (result === 'sent') delivered += 1;
      // idle / retrying 说明队列已空或飞书在限流，留到下一轮，避免一轮内连续撞限流。
      if (result !== 'sent' && result !== 'abandoned') break;
    }
    return delivered;
  }

  async deliverOne(now = Date.now()): Promise<DeliveryResult> {
    const config = await this.readConfig();
    if (!config.notifications_enabled || now < this.nextAllowedAt) return 'disabled';
    return this.deliverClaimed(config);
  }

  /**
   * 同一事故、同一 transition 只保留最新一张。连续抖动会写出成串的 firing/recovered，
   * 按 FIFO 逐张发送会让群里在故障结束后很久还在收旧卡。不跨 transition 合并：
   * 支付域的恢复卡会被抑制，跨 transition 合并可能让一张不会发出的恢复卡顶掉 P0 故障卡。
   */
  private async supersedeStale(): Promise<void> {
    const count = await prisma.$executeRaw(Prisma.sql`
      UPDATE ops.alert_delivery_jobs stale
      SET state = 'abandoned', next_attempt_at = NULL, last_error_class = 'superseded', updated_at = now()
      WHERE stale.state IN ('pending', 'failed')
        AND EXISTS (
          SELECT 1 FROM ops.alert_delivery_jobs newer
          WHERE newer.incident_id = stale.incident_id
            AND newer.transition = stale.transition
            AND newer.id > stale.id
        )
    `);
    if (count > 0) {
      this.log.biz.info(
        { event: 'alert.delivery.superseded', count },
        '同一事故的旧告警通知已被更新的通知取代'
      );
    }
  }

  private async deliverClaimed(config: AlertingRuntimeConfig): Promise<DeliveryResult> {
    const row = await this.claim();
    if (!row) return 'idle';
    const card = row.payload as SafeAlertCard;
    if (feishuNotificationSuppressed(card)) {
      await prisma.$executeRaw(Prisma.sql`
        UPDATE ops.alert_delivery_jobs
        SET state = 'abandoned', next_attempt_at = NULL, last_error_class = 'notify_suppressed', updated_at = now()
        WHERE id = ${row.id} AND state = 'sending'
      `);
      this.log.biz.info(
        {
          event: 'alert.delivery.suppressed',
          notificationKey: row.notification_key,
          severity: card.severity,
        },
        '告警通知已按当前规则关闭'
      );
      return 'abandoned';
    }
    const result = await this.sink.deliver(card, config.feishu_timeout_ms);
    this.nextAllowedAt = Date.now() + config.min_delivery_interval_ms;
    if (result.kind === 'succeeded') {
      await prisma.$executeRaw(Prisma.sql`
        UPDATE ops.alert_delivery_jobs
        SET state = 'succeeded', delivered_at = now(), updated_at = now(), last_error_class = NULL
        WHERE id = ${row.id} AND state = 'sending'
      `);
      this.log.biz.info(
        { event: 'alert.delivery.sent', notificationKey: row.notification_key },
        '告警通知已发送'
      );
      return 'sent';
    }
    const exhausted = result.kind === 'permanent' || row.attempt_count >= config.max_attempts;
    if (exhausted) {
      await prisma.$executeRaw(Prisma.sql`
        UPDATE ops.alert_delivery_jobs
        SET state = 'abandoned', next_attempt_at = NULL, last_error_class = ${result.errorClass}, updated_at = now()
        WHERE id = ${row.id} AND state = 'sending'
      `);
      this.log.sys.warn(
        {
          event: 'alert.delivery.abandoned',
          notificationKey: row.notification_key,
          errorClass: result.errorClass,
        },
        '告警通知重试耗尽'
      );
      return 'abandoned';
    }
    const retryAfter = result.kind === 'retryable' ? result.retryAfterMs : undefined;
    const delay = backoffMs(row.attempt_count, retryAfter);
    await prisma.$executeRaw(Prisma.sql`
      UPDATE ops.alert_delivery_jobs
      SET state = 'failed', next_attempt_at = now() + (${delay} * interval '1 millisecond'),
          last_error_class = ${result.errorClass}, updated_at = now()
      WHERE id = ${row.id} AND state = 'sending'
    `);
    this.log.sys.warn(
      {
        event: 'alert.delivery.retry',
        notificationKey: row.notification_key,
        errorClass: result.errorClass,
        delayMs: delay,
      },
      '告警通知等待重试'
    );
    return 'retrying';
  }

  private async claim(): Promise<DeliveryRow | null> {
    // maxWait < 共享池 pool_timeout，池满时快速失败而不是与在线请求一起挂满 10s。
    return prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<DeliveryRow[]>(Prisma.sql`
        WITH due AS (
          SELECT id FROM ops.alert_delivery_jobs
          WHERE (
            state IN ('pending', 'failed') AND next_attempt_at <= now()
          ) OR (
            state = 'sending' AND last_attempt_at < now() - interval '2 minutes'
          )
          ORDER BY next_attempt_at NULLS FIRST, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE ops.alert_delivery_jobs attempts
        SET state = 'sending', attempt_count = attempts.attempt_count + 1,
            last_attempt_at = now(), updated_at = now()
        FROM due WHERE attempts.id = due.id
        RETURNING attempts.id, attempts.notification_key, attempts.payload, attempts.attempt_count
      `);
        return rows[0] ?? null;
      },
      { maxWait: 5_000, timeout: 15_000 }
    );
  }
}
