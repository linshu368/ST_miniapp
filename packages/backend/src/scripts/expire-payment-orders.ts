import '../platform/config.js';
import { config } from '../platform/config.js';
import { createLogger } from '../lib/logger.js';
import { MiniappPaymentOrderRepository } from '../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import { ZqPaymentGateway } from '../infrastructure/payment/ZqPaymentGateway.js';
import { runExpirePaymentOrders } from '../features/payment/usecases/ExpirePaymentOrders.js';

const log = createLogger('payment');

try {
  const result = await runExpirePaymentOrders({
    orders: new MiniappPaymentOrderRepository(),
    gateway: new ZqPaymentGateway(),
    log,
    paymentEnabled: config.payment.enabled,
  });

  console.log(`Reconciled before expiry: checked=${result.checked} settled=${result.settled}`);
  console.log(`Expired payment orders: ${result.expired}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log.sys.error({ event: 'payment.cron.failed', err: error }, '支付订单过期任务失败');
  console.error(`Expire payment orders failed: ${message}`);
  process.exit(1);
}
