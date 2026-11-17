import { runObservedJob } from '../platform/observability/jobs.js';
import '../instrumentation.js';
import { config } from '../platform/config.js';
import { createLogger } from '../lib/logger.js';
import { withSessionAdvisoryLock } from '../lib/postgres-advisory-lease.js';
import {
  observeBackgroundRun,
  startStandaloneObservability,
} from '../lib/background-observability.js';
import { EpayPaymentGateway } from '../infrastructure/payment/EpayPaymentGateway.js';
import { AlertPublisher } from '../features/alerting/publisher.js';
import { paymentProbeGuard } from '../features/payment/availability/probe.js';
import {
  runPaymentProbeRound,
  type PaymentProbeRoundResult,
} from '../features/payment/availability/round.js';
import { createPaymentAvailabilityStrategies } from '../features/payment/availability/strategies/index.js';

const log = createLogger('payment-availability-probe');
const startedAt = performance.now();
const shutdown = new AbortController();
const stopObservability = startStandaloneObservability();
const ADVISORY_LOCK_KEY = 731_007;

/** Project only facts already returned by the probe; never pass nested payment/provider objects. */
function probeSummary(result: PaymentProbeRoundResult) {
  const probe = result.probe;
  const observed = probe?.kind === 'available' || probe?.kind === 'unavailable' ? probe : undefined;
  return {
    outcome: result.outcome,
    probe_result: probe?.kind,
    reason: result.reason ?? (probe && 'reason' in probe ? probe.reason : undefined),
    paymentType: observed?.channel,
    duration_ms: observed?.durationMs,
    errorClass: observed?.errorClass,
    strategy_success_count: result.strategies.filter((item) => item.outcome === 'succeeded').length,
    strategy_failed_count: result.strategies.filter((item) => item.outcome === 'failed').length,
    strategy_skipped_count: result.strategies.filter((item) => item.outcome === 'skipped').length,
    strategy_timed_out_count: result.strategies.filter((item) => item.outcome === 'timed_out')
      .length,
    strategy_cancelled_count: result.strategies.filter((item) => item.outcome === 'cancelled')
      .length,
  };
}
let outcome: 'success' | 'partial' | 'error' | 'skipped' = 'error';
let disconnect: (() => Promise<void>) | undefined;
const onShutdown = () => shutdown.abort();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, onShutdown);
// Reserve time for strategy cancellation and connection cleanup before the hard process limit.
const cleanupDeadline = setTimeout(() => shutdown.abort(), 45_000);
cleanupDeadline.unref();
// Railway must not keep this one-shot alive on a broken dependency or non-cooperative future strategy.
const hardDeadline = setTimeout(() => {
  log.sys.error({ event: 'payment.probe.deadline_exceeded' }, '支付探测任务超过总时限');
  process.exit(1);
}, 60_000);
hardDeadline.unref();

await runObservedJob('payment_availability_probe', async () => {
  try {
    const guarded = paymentProbeGuard(config.paymentProbe);
    if (guarded) {
      outcome = guarded.kind === 'skipped' ? 'skipped' : 'error';
      log.biz.info(
        {
          event: 'payment.probe.guarded',
          outcome: guarded.kind === 'skipped' ? 'skipped' : 'failed',
          probe_result: guarded.kind,
          ...('reason' in guarded ? { reason: guarded.reason } : {}),
        },
        '支付探测未发送请求'
      );
    } else {
      // Disabled/preview runs must not initialize or connect the alert database client.
      const [{ PrismaAlertPersistence }, { prisma }] = await Promise.all([
        import('../features/alerting/repository.js'),
        import('../lib/db.js'),
      ]);
      disconnect = () => prisma.$disconnect();
      const publisher = new AlertPublisher(new PrismaAlertPersistence(), log);
      const result = await runPaymentProbeRound({
        settings: config.paymentProbe,
        gateway: new EpayPaymentGateway(),
        strategies: createPaymentAvailabilityStrategies(publisher, config.database.environment),
        signal: shutdown.signal,
        withLease: (work) =>
          withSessionAdvisoryLock(ADVISORY_LOCK_KEY, work, {
            onCleanupError(stage, err) {
              log.sys.error(
                { event: 'payment.probe.lease_cleanup_failed', stage, err },
                '支付探测锁清理失败'
              );
            },
          }),
      });
      outcome = result.outcome;
      log.biz.info(
        { event: 'payment.probe.completed', ...probeSummary(result) },
        '支付探测轮次结束'
      );
    }
  } catch (err) {
    log.sys.error({ event: 'payment.probe.failed', err }, '支付探测轮次失败');
  } finally {
    try {
      await disconnect?.();
    } catch (err) {
      outcome = 'error';
      log.sys.error({ event: 'payment.probe.cleanup_failed', err }, '支付探测连接清理失败');
    }
    if (shutdown.signal.aborted) outcome = 'error';
    observeBackgroundRun({ job: 'payment_availability_probe', outcome, startedAt });
    await stopObservability();
    clearTimeout(cleanupDeadline);
    clearTimeout(hardDeadline);
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.removeListener(signal, onShutdown);
    process.exitCode = outcome === 'partial' || outcome === 'error' ? 1 : 0;
  }
});
