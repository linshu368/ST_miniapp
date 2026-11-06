import '../instrumentation.js';
import { config } from '../platform/config.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLogger } from '../lib/logger.js';
import { withSessionAdvisoryLock } from '../lib/postgres-advisory-lease.js';
import { AlertDeliveryWorker } from '../features/alerting/delivery-worker.js';
import { FeishuAlertSink } from '../features/alerting/feishu-alert-sink.js';
import { AlertPublisher } from '../features/alerting/publisher.js';
import { PrismaAlertPersistence } from '../features/alerting/repository.js';
import {
  PaymentAlertMonitor,
  PaymentAlertMonitorRepository,
} from '../features/payment/usecases/PaymentAlertMonitor.js';
import { VeniceBalanceMonitor } from '../features/generation/venice-balance-alerts.js';
import {
  observeBackgroundRun,
  startStandaloneObservability,
} from '../lib/background-observability.js';

const log = createLogger('payment-alert-monitor');
const alertPublisher = new AlertPublisher(new PrismaAlertPersistence(), log);
const monitor = new PaymentAlertMonitor(new PaymentAlertMonitorRepository(), alertPublisher, log);
const veniceBalanceMonitor = new VeniceBalanceMonitor(alertPublisher, log);
const deliveryWorker = new AlertDeliveryWorker(
  new FeishuAlertSink(config.alerting.feishuWebhookUrl),
  log
);
const shutdown = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => shutdown.abort());
const ADVISORY_LOCK_KEY = 731_006;
const stopObservability = startStandaloneObservability();

// The lease owns a direct PostgreSQL session for this complete round. Prisma's pooled connection
// must not be used for session-level advisory locks because unlock could land on another session.
while (!shutdown.signal.aborted) {
  const observationStartedAt = performance.now();
  let outcome: 'success' | 'partial' | 'error' | 'skipped' = 'success';
  try {
    const result = await withSessionAdvisoryLock(
      ADVISORY_LOCK_KEY,
      async () => {
        await monitor.runOnce();
        // Venice USD 余额检查与支付规则解耦：失败只标记 partial，不阻断 outbox drain。
        try {
          const balance = await veniceBalanceMonitor.runOnce();
          if (balance.outcome === 'probe_failed') outcome = 'partial';
        } catch (err) {
          outcome = 'partial';
          log.sys.error(
            { event: 'venice.balance_monitor.failed', err },
            'Venice 余额监控本轮失败；不发布 healthy'
          );
        }
        // Delivery is non-critical: a failed drain must not make an otherwise successful monitor run fail.
        try {
          await deliveryWorker.deliverOne();
        } catch (err) {
          outcome = 'partial';
          log.sys.error(
            { event: 'payment.alert_monitor.delivery_failed', err },
            '支付告警通知投递本轮失败；监控将在下一轮继续'
          );
        }
      },
      {
        onCleanupError(stage, err) {
          log.sys.error(
            { event: 'payment.alert_monitor.lease_cleanup_failed', stage, err },
            '支付告警监控租约清理失败；连接关闭后 PostgreSQL 将释放 session lock'
          );
        },
      }
    );
    if (!result.acquired) {
      outcome = 'skipped';
      log.sys.warn({ event: 'payment.alert_monitor.overlap' }, '支付告警监控轮次因租约被跳过');
    }
    observeBackgroundRun({
      job: 'payment_alert_monitor',
      outcome,
      startedAt: observationStartedAt,
    });
  } catch (err) {
    observeBackgroundRun({
      job: 'payment_alert_monitor',
      outcome: 'error',
      startedAt: observationStartedAt,
      error: err,
    });
    log.sys.error(
      { event: 'payment.alert_monitor.failed', err },
      '支付告警监控本轮失败；未发布 healthy'
    );
  }
  try {
    await sleep(60_000, undefined, { signal: shutdown.signal });
  } catch {
    /* shutdown */
  }
}

await stopObservability();
