/**
 * backend / features / payment / usecases / PaymentCallbackReport.ts
 *
 * 回调监控日报的聚合口径。回答三个问题里的两个：
 *   · 当天订单的入账路径分布（webhook / return / query / cron）
 *   · 各路径从建单到入账的耗时，其中 cron 那行就是兜底追回的平均耗时
 *
 * 第三个问题「cron 查单成功率」不在这里：查单失败的订单永远不会变成 completed，
 * 订单表上没有失败这件事，只能看 cron 的 payment.fast_cron.reconciled 汇总日志。
 *
 * 纯函数，不碰库不碰时钟，口径改动可单测钉住。
 */

import type { PaymentOrderStatus, PaymentSettlementSource } from '@miniapp/shared';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 运营看的是「当天」，CST 固定 +08:00，无夏令时，不需要时区库。 */
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 固定顺序输出，缺的路径也占一行——「webhook 今天 0 条」本身就是结论。 */
const SETTLEMENT_SOURCES: readonly PaymentSettlementSource[] = [
  'webhook',
  'return',
  'query',
  'cron',
];

/** migration 101 之前入账的订单没有来源，单列一行，不摊进四条路径里。 */
export const UNKNOWN_SETTLEMENT_SOURCE = 'unknown';

export interface ReportDayRange {
  /** CST 日期，形如 2026-08-27 */
  label: string;
  /** 含 */
  since: string;
  /** 不含 */
  until: string;
}

export interface ReportOrderRow {
  status: PaymentOrderStatus;
  amount_cents: number;
  created_at: string;
  paid_at: string | null;
  settled_by: PaymentSettlementSource | null;
}

export interface SettlementSourceStat {
  source: PaymentSettlementSource | typeof UNKNOWN_SETTLEMENT_SOURCE;
  orders: number;
  /** 占当天已入账订单的比例，0–1 */
  share: number;
  amountCents: number;
  /** 建单到入账的平均秒数；含用户付款前的停留时间 */
  avgSettleSeconds: number | null;
  maxSettleSeconds: number | null;
}

export interface PaymentCallbackReport {
  range: ReportDayRange;
  createdOrders: number;
  completedOrders: number;
  /** completed / created */
  completionRate: number;
  completedAmountCents: number;
  statusCounts: Record<PaymentOrderStatus, number>;
  sources: SettlementSourceStat[];
}

/** daysAgo=0 是今天，1 是昨天（日报在 00:xx 跑时要看的那天）。 */
export function resolveShanghaiDayRange(now: number, daysAgo = 0): ReportDayRange {
  const shifted = now + SHANGHAI_UTC_OFFSET_MS;
  const dayStartShifted = Math.floor(shifted / DAY_MS) * DAY_MS - daysAgo * DAY_MS;
  const startMs = dayStartShifted - SHANGHAI_UTC_OFFSET_MS;

  return {
    label: new Date(dayStartShifted).toISOString().slice(0, 10),
    since: new Date(startMs).toISOString(),
    until: new Date(startMs + DAY_MS).toISOString(),
  };
}

export function buildPaymentCallbackReport(
  rows: readonly ReportOrderRow[],
  range: ReportDayRange
): PaymentCallbackReport {
  const statusCounts: Record<PaymentOrderStatus, number> = {
    pending: 0,
    completed: 0,
    expired: 0,
    failed: 0,
  };
  for (const row of rows) {
    statusCounts[row.status] += 1;
  }

  const completed = rows.filter((row) => row.status === 'completed');
  const buckets = new Map<string, ReportOrderRow[]>();
  for (const row of completed) {
    const key = row.settled_by ?? UNKNOWN_SETTLEMENT_SOURCE;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }

  const keys: Array<PaymentSettlementSource | typeof UNKNOWN_SETTLEMENT_SOURCE> = [
    ...SETTLEMENT_SOURCES,
  ];
  if (buckets.has(UNKNOWN_SETTLEMENT_SOURCE)) keys.push(UNKNOWN_SETTLEMENT_SOURCE);

  const sources = keys.map((source) =>
    summarizeSource(source, buckets.get(source) ?? [], completed.length)
  );

  return {
    range,
    createdOrders: rows.length,
    completedOrders: completed.length,
    completionRate: ratio(completed.length, rows.length),
    completedAmountCents: completed.reduce((total, row) => total + row.amount_cents, 0),
    statusCounts,
    sources,
  };
}

function summarizeSource(
  source: PaymentSettlementSource | typeof UNKNOWN_SETTLEMENT_SOURCE,
  rows: readonly ReportOrderRow[],
  completedTotal: number
): SettlementSourceStat {
  // paid_at 缺失只会出现在补数据一类的异常行上，算耗时要跳过，算笔数不能跳。
  const durations = rows
    .map((row) => settleSeconds(row))
    .filter((seconds): seconds is number => seconds !== null);

  return {
    source,
    orders: rows.length,
    share: ratio(rows.length, completedTotal),
    amountCents: rows.reduce((total, row) => total + row.amount_cents, 0),
    avgSettleSeconds: durations.length
      ? round1(durations.reduce((total, seconds) => total + seconds, 0) / durations.length)
      : null,
    maxSettleSeconds: durations.length ? round1(Math.max(...durations)) : null,
  };
}

function settleSeconds(row: ReportOrderRow): number | null {
  if (!row.paid_at) return null;
  const paidAt = Date.parse(row.paid_at);
  const createdAt = Date.parse(row.created_at);
  if (!Number.isFinite(paidAt) || !Number.isFinite(createdAt)) return null;
  return (paidAt - createdAt) / 1000;
}

export function formatPaymentCallbackReport(report: PaymentCallbackReport): string {
  const { range, statusCounts } = report;
  const lines = [
    `支付回调日报 ${range.label} (CST)  ${range.since} → ${range.until}`,
    `当天建单 ${report.createdOrders} 笔｜已入账 ${report.completedOrders} 笔` +
      `（${percent(report.completionRate)}）｜金额 ${yuan(report.completedAmountCents)} 元`,
    `订单状态 pending=${statusCounts.pending} completed=${statusCounts.completed} ` +
      `expired=${statusCounts.expired} failed=${statusCounts.failed}`,
    '',
    // 表头是中文，占两个显示宽度，不能和下面的数据列用同一套 padStart 宽度。
    '入账路径' +
      ' '.repeat(12) +
      '笔数' +
      ' '.repeat(5) +
      '占比' +
      ' '.repeat(5) +
      '平均耗时' +
      ' '.repeat(5) +
      '最长耗时' +
      ' '.repeat(5) +
      '金额(元)',
  ];

  for (const stat of report.sources) {
    lines.push(
      [
        stat.source.padEnd(20),
        String(stat.orders).padStart(4),
        percent(stat.share).padStart(9),
        seconds(stat.avgSettleSeconds).padStart(13),
        seconds(stat.maxSettleSeconds).padStart(13),
        yuan(stat.amountCents).padStart(13),
      ].join('')
    );
  }

  if (report.completedOrders === 0) {
    lines.push('', '当天没有已入账订单。');
  }

  return lines.join('\n');
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function seconds(value: number | null): string {
  return value === null ? '-' : `${value.toFixed(1)}s`;
}

function yuan(amountCents: number): string {
  return (amountCents / 100).toFixed(2);
}

function ratio(part: number, total: number): number {
  return total === 0 ? 0 : part / total;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
