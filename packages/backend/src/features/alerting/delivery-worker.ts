import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/db.js';
import type { Logger } from '../../lib/logger.js';
import { FeishuAlertSink } from './feishu-alert-sink.js';
import { readAlertingRuntimeConfig, type AlertingRuntimeConfig } from './runtime-config.js';
import type { SafeAlertCard } from './safe-card.js';
import { backoffMs } from './semantics.js';

/** P1 飞书通知关闭；已注释的旧 P0 即使还在队列里也不再发送。 */
function feishuNotificationSuppressed(card: SafeAlertCard): boolean {
  if (card.severity === 'P1') return true;
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

/** Drains at most one intent; callers schedule it after a producer run without blocking that run. */
export class AlertDeliveryWorker {
  private nextAllowedAt = 0;

  constructor(
    private readonly sink: FeishuAlertSink,
    private readonly log: Pick<Logger, 'biz' | 'sys'>,
    private readonly readConfig: () => Promise<AlertingRuntimeConfig> = readAlertingRuntimeConfig
  ) {}

  async deliverOne(
    now = Date.now()
  ): Promise<'disabled' | 'idle' | 'sent' | 'retrying' | 'abandoned'> {
    const config = await this.readConfig();
    if (!config.notifications_enabled || now < this.nextAllowedAt) return 'disabled';
    const row = await this.claim();
    if (!row) return 'idle';
    const card = row.payload as SafeAlertCard;
    if (feishuNotificationSuppressed(card)) {
      await prisma.$executeRaw(Prisma.sql`
        UPDATE app_core.alert_delivery_attempts
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
        UPDATE app_core.alert_delivery_attempts
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
        UPDATE app_core.alert_delivery_attempts
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
      UPDATE app_core.alert_delivery_attempts
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
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<DeliveryRow[]>(Prisma.sql`
        WITH due AS (
          SELECT id FROM app_core.alert_delivery_attempts
          WHERE (
            state IN ('pending', 'failed') AND next_attempt_at <= now()
          ) OR (
            state = 'sending' AND last_attempt_at < now() - interval '2 minutes'
          )
          ORDER BY next_attempt_at NULLS FIRST, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE app_core.alert_delivery_attempts attempts
        SET state = 'sending', attempt_count = attempts.attempt_count + 1,
            last_attempt_at = now(), updated_at = now()
        FROM due WHERE attempts.id = due.id
        RETURNING attempts.id, attempts.notification_key, attempts.payload, attempts.attempt_count
      `);
      return rows[0] ?? null;
    });
  }
}
