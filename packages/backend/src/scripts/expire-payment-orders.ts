import '../platform/config.js';
import { config } from '../platform/config.js';
import { createLogger } from '../lib/logger.js';
import { closeSupabaseClient } from '../lib/supabase.js';
import { MiniappPaymentOrderRepository } from '../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import { VexutopiaPaymentGateway } from '../infrastructure/payment/VexutopiaPaymentGateway.js';
import { runPaymentReconciliation } from '../features/payment/usecases/PaymentReconciliation.js';

const log = createLogger('payment');
const orders = new MiniappPaymentOrderRepository();
let exitCode = 0;

try {
  // 先查单补账、再判过期；即使对账 worker 停了，这一步也能把已付款订单追回来。
  const result = await runPaymentReconciliation({
    orders,
    gateway: new VexutopiaPaymentGateway(),
    log,
    paymentEnabled: config.payment.enabled,
    trigger: 'expiry_reconcile',
    events: orders,
  });
  console.log(
    `Reconciled before expiry: checked=${result.checked} settled=${result.settled} ` +
      `closed=${result.closed} lookupFailed=${result.lookupFailed}`
  );

  // 不知道平台状态时不关单：过期虽然能被迟到确认重开，但会让用户看到错误的“已失效”。
  if (result.lookupFailed) {
    log.sys.error({ event: 'payment.cron.expiry_skipped' }, '批量查单失败，跳过本轮订单过期');
    console.log('Expired payment orders: skipped (lookup failed)');
  } else {
    const expired = await orders.expireAllPending();
    console.log(`Expired payment orders: ${expired}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log.sys.error({ event: 'payment.cron.failed', err: error }, '支付订单过期任务失败');
  console.error(`Expire payment orders failed: ${message}`);
  exitCode = 1;
} finally {
  try {
    await closeSupabaseClient();
  } catch (error) {
    log.sys.error({ event: 'payment.cron.cleanup_failed', err: error }, '支付定时任务资源清理失败');
    exitCode = 1;
  }

  process.exit(exitCode);
}
