/**
 * backend / scripts / payment-callback-report.ts
 *
 * 只读日报：当天创建的订单，最终由哪条路径入账、各路径耗时多少。
 * 不写库、不查厂商、不入账，可以随时对生产跑。
 *
 *   pnpm --filter @miniapp/backend payment:callback-report
 *   pnpm --filter @miniapp/backend payment:callback-report -- --days-ago=1
 *   pnpm --filter @miniapp/backend payment:callback-report -- --json
 *
 *   pnpm exec railway run -e production -s stminiapp -- \
 *     pnpm --filter @miniapp/backend payment:callback-report
 *
 * cron 查单成功率不在本脚本里：查单失败的订单不会变成 completed，订单表上没有这件事。
 * 该指标看 cron 服务的汇总日志，命令见
 * docs/payment-missing-credits-remediation.md 的「回调监控」一节。
 */

import '../platform/config.js';
import {
  buildPaymentCallbackReport,
  formatPaymentCallbackReport,
  resolveShanghaiDayRange,
} from '../features/payment/usecases/PaymentCallbackReport.js';
import { MiniappPaymentOrderRepository } from '../infrastructure/repositories/MiniappPaymentOrderRepository.js';
import { createLogger } from '../lib/logger.js';
import { closeSupabaseClient } from '../lib/supabase.js';

const log = createLogger('payment');
const args = process.argv.slice(2);
let exitCode = 0;

try {
  const range = resolveShanghaiDayRange(Date.now(), parseDaysAgo(args));
  const orders = await new MiniappPaymentOrderRepository().listCreatedBetween({
    since: range.since,
    until: range.until,
  });
  const report = buildPaymentCallbackReport(orders, range);

  console.log(
    args.includes('--json') ? JSON.stringify(report) : formatPaymentCallbackReport(report)
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log.sys.error({ event: 'payment.report.failed', err: error }, '支付回调日报生成失败');
  console.error(`Payment callback report failed: ${message}`);
  exitCode = 1;
} finally {
  try {
    await closeSupabaseClient();
  } catch (error) {
    log.sys.error(
      { event: 'payment.report.cleanup_failed', err: error },
      '支付回调日报资源清理失败'
    );
    exitCode = 1;
  }

  process.exit(exitCode);
}

function parseDaysAgo(argv: readonly string[]): number {
  const raw = argv.find((arg) => arg.startsWith('--days-ago='))?.split('=')[1];
  if (raw === undefined) return 0;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--days-ago 需要非负整数，收到 ${raw}`);
  }
  return parsed;
}
