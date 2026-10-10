import '../platform/config.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { prisma } from '../lib/db.js';
import { createLogger } from '../lib/logger.js';
import { AlertPublisher } from '../features/alerting/publisher.js';
import { PrismaAlertPersistence } from '../features/alerting/repository.js';
import {
  PaymentAlertMonitor,
  PaymentAlertMonitorRepository,
} from '../features/payment/usecases/PaymentAlertMonitor.js';

const log = createLogger('payment-alert-monitor');
const monitor = new PaymentAlertMonitor(
  new PaymentAlertMonitorRepository(),
  new AlertPublisher(new PrismaAlertPersistence(), log),
  log
);
const shutdown = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => shutdown.abort());
// Advisory locking is database-scoped, so duplicate Railway instances skip rather than overlap.
while (!shutdown.signal.aborted) {
  try {
    const rows = await prisma.$queryRaw<
      Array<{ locked: boolean }>
    >`SELECT pg_try_advisory_lock(731006) AS locked`;
    if (rows[0]?.locked) {
      try {
        await monitor.runOnce();
      } finally {
        await prisma.$executeRaw`SELECT pg_advisory_unlock(731006)`;
      }
    } else log.sys.warn({ event: 'payment.alert_monitor.overlap' }, '支付告警监控轮次因租约被跳过');
  } catch (err) {
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
