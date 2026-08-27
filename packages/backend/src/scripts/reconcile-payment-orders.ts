import '../platform/config.js';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  runDualPassFastPaymentReconciliation,
  runFastPaymentReconciliation,
} from '../features/payment/usecases/FastPaymentReconciliation.js';
import { MiniappPaymentOrderRepository } from '../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import { ZqPaymentGateway } from '../infrastructure/payment/ZqPaymentGateway.js';
import { createLogger } from '../lib/logger.js';
import { closeSupabaseClient } from '../lib/supabase.js';
import { config } from '../platform/config.js';

const log = createLogger('payment');
const orders = new MiniappPaymentOrderRepository();
const gateway = new ZqPaymentGateway();
let exitCode = 0;

try {
  const result = await runDualPassFastPaymentReconciliation({
    runPass: () =>
      runFastPaymentReconciliation({
        orders,
        gateway,
        log,
        paymentEnabled: config.payment.enabled,
      }),
    sleep,
  });

  console.log(
    `Fast payment reconciliation: checked=${result.checked} claimed=${result.claimed} ` +
      `settled=${result.settled} unpaid=${result.unpaid} failed=${result.failed}`
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log.sys.error({ event: 'payment.fast_cron.failed', err: error }, '支付订单快速对账任务失败');
  console.error(`Fast payment reconciliation failed: ${message}`);
  exitCode = 1;
} finally {
  try {
    await closeSupabaseClient();
  } catch (error) {
    log.sys.error(
      { event: 'payment.fast_cron.cleanup_failed', err: error },
      '支付订单快速对账资源清理失败'
    );
    exitCode = 1;
  }

  process.exit(exitCode);
}
