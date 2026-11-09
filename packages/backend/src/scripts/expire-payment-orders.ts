import '../instrumentation.js';
import '../platform/config.js';
import { createLogger } from '../lib/logger.js';
import { closeSupabaseClient } from '../lib/supabase.js';
import { MiniappPaymentOrderRepository } from '../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import { EpayPaymentGateway } from '../infrastructure/payment/EpayPaymentGateway.js';
import { runPaymentReconciliation } from '../features/payment/usecases/PaymentReconciliation.js';
import {
  observeBackgroundRun,
  startStandaloneObservability,
} from '../lib/background-observability.js';

const log = createLogger('payment');
const orders = new MiniappPaymentOrderRepository();
const gateway = new EpayPaymentGateway();
let exitCode = 0;
let outcome: 'success' | 'partial' | 'error' = 'success';
let terminalError: unknown;
const observationStartedAt = performance.now();
const stopObservability = startStandaloneObservability();

try {
  // 先查单补账、再判过期；即使对账 worker 停了，这一步也能把已付款订单追回来。
  const result = await runPaymentReconciliation({
    orders,
    gateway,
    log,
    paymentEnabled: gateway.configured,
    trigger: 'expiry_reconcile',
    events: orders,
  });
  console.log(
    `Reconciled before expiry: checked=${result.checked} settled=${result.settled} ` +
      `closed=${result.closed} lookupFailed=${result.lookupFailed}`
  );

  if (result.lookupFailed) {
    outcome = 'partial';
    log.sys.warn(
      { event: 'payment.cron.partial' },
      'Some queries failed; those orders remain recoverable'
    );
  }
  console.log(`Expired queried unpaid orders: ${result.closed}`);
} catch (error) {
  terminalError = error;
  outcome = 'error';
  const message = error instanceof Error ? error.message : String(error);
  log.sys.error({ event: 'payment.cron.failed', err: error }, '支付订单过期任务失败');
  console.error(`Expire payment orders failed: ${message}`);
  exitCode = 1;
} finally {
  try {
    await closeSupabaseClient();
  } catch (error) {
    terminalError ??= error;
    outcome = 'error';
    log.sys.error({ event: 'payment.cron.cleanup_failed', err: error }, '支付定时任务资源清理失败');
    exitCode = 1;
  }

  observeBackgroundRun({
    job: 'expire_payment_orders',
    outcome,
    startedAt: observationStartedAt,
    error: terminalError,
  });
  await stopObservability();
  process.exitCode = exitCode;
}
