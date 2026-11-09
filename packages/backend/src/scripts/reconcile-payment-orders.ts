import '../instrumentation.js';
import '../platform/config.js';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  runPaymentReconciliation,
  runPaymentReconciliationLoop,
} from '../features/payment/usecases/PaymentReconciliation.js';
import { MiniappPaymentOrderRepository } from '../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import { EpayPaymentGateway } from '../infrastructure/payment/EpayPaymentGateway.js';
import { createLogger } from '../lib/logger.js';
import { closeSupabaseClient } from '../lib/supabase.js';
import {
  observeBackgroundRun,
  startStandaloneObservability,
} from '../lib/background-observability.js';

const log = createLogger('payment');
const orders = new MiniappPaymentOrderRepository();
const gateway = new EpayPaymentGateway();
const shutdown = new AbortController();
let exitCode = 0;
let passStartedAt = performance.now();
const stopObservability = startStandaloneObservability();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    if (!shutdown.signal.aborted) shutdown.abort();
  });
}

log.sys.info(
  { event: 'payment.reconcile_worker.started', paymentEnabled: gateway.configured },
  '支付订单对账 worker 启动'
);

try {
  await runPaymentReconciliationLoop({
    runPass: () => {
      passStartedAt = performance.now();
      return runPaymentReconciliation({
        orders,
        gateway,
        log,
        paymentEnabled: gateway.configured,
        trigger: 'fast_reconcile',
        events: orders,
        signal: shutdown.signal,
      });
    },
    sleep: async (milliseconds, signal) => {
      try {
        await sleep(milliseconds, undefined, { signal });
      } catch (error) {
        if (signal?.aborted) return;
        throw error;
      }
    },
    signal: shutdown.signal,
    onPass: (result) => {
      observeBackgroundRun({
        job: 'payment_reconciliation',
        outcome: !gateway.configured ? 'skipped' : result.lookupFailed ? 'partial' : 'success',
        startedAt: passStartedAt,
      });
      if (!gateway.configured) {
        console.log('Payment reconciliation skipped: provider credentials are not configured');
        return;
      }
      console.log(
        `Payment reconciliation: checked=${result.checked} settled=${result.settled} ` +
          `closed=${result.closed} lookupFailed=${result.lookupFailed}`
      );
    },
    onError: (error) => {
      observeBackgroundRun({
        job: 'payment_reconciliation',
        outcome: 'error',
        startedAt: passStartedAt,
        error,
      });
      const message = error instanceof Error ? error.message : String(error);
      log.sys.error(
        { event: 'payment.reconcile_worker.failed', err: error },
        '支付订单对账本轮失败'
      );
      console.error(`Payment reconciliation failed: ${message}`);
    },
  });
} catch (error) {
  observeBackgroundRun({
    job: 'payment_reconciliation_worker',
    outcome: 'error',
    startedAt: passStartedAt,
    error,
  });
  const message = error instanceof Error ? error.message : String(error);
  log.sys.error(
    { event: 'payment.reconcile_worker.failed', err: error },
    '支付订单对账 worker 退出'
  );
  console.error(`Payment reconciliation worker failed: ${message}`);
  exitCode = 1;
} finally {
  log.sys.info({ event: 'payment.reconcile_worker.stopped' }, '支付订单对账 worker 停止');
  try {
    await closeSupabaseClient();
  } catch (error) {
    log.sys.error(
      { event: 'payment.reconcile_worker.cleanup_failed', err: error },
      '支付订单对账资源清理失败'
    );
    exitCode = 1;
  }

  await stopObservability();
  process.exitCode = exitCode;
}
