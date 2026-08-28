import '../platform/config.js';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  runFastPaymentReconciliation,
  runFastPaymentReconciliationLoop,
} from '../features/payment/usecases/FastPaymentReconciliation.js';
import { MiniappPaymentOrderRepository } from '../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import { ZqPaymentGateway } from '../infrastructure/payment/ZqPaymentGateway.js';
import { createLogger } from '../lib/logger.js';
import { closeSupabaseClient } from '../lib/supabase.js';
import { config } from '../platform/config.js';

const log = createLogger('payment');
const orders = new MiniappPaymentOrderRepository();
const gateway = new ZqPaymentGateway();
const shutdown = new AbortController();
let exitCode = 0;

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    if (!shutdown.signal.aborted) shutdown.abort();
  });
}

log.sys.info(
  { event: 'payment.fast_cron.started', paymentEnabled: config.payment.enabled },
  '支付订单快速对账 worker 启动'
);

try {
  await runFastPaymentReconciliationLoop({
    runPass: () =>
      runFastPaymentReconciliation({
        orders,
        gateway,
        log,
        paymentEnabled: config.payment.enabled,
      }),
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
      if (!config.payment.enabled) {
        console.log('Fast payment reconciliation skipped: PAYMENT_ENABLED is not true');
        return;
      }
      console.log(
        `Fast payment reconciliation: checked=${result.checked} claimed=${result.claimed} ` +
          `settled=${result.settled} unpaid=${result.unpaid} failed=${result.failed}`
      );
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      log.sys.error({ event: 'payment.fast_cron.failed', err: error }, '支付订单快速对账本轮失败');
      console.error(`Fast payment reconciliation failed: ${message}`);
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log.sys.error({ event: 'payment.fast_cron.failed', err: error }, '支付订单快速对账 worker 退出');
  console.error(`Fast payment reconciliation worker failed: ${message}`);
  exitCode = 1;
} finally {
  log.sys.info({ event: 'payment.fast_cron.stopped' }, '支付订单快速对账 worker 停止');
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
