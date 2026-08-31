import { describe, expect, it } from 'vitest';

import {
  buildPaymentCallbackReport,
  formatPaymentCallbackReport,
  resolveShanghaiDayRange,
  type ReportOrderRow,
} from './PaymentCallbackReport.js';

function row(overrides: Partial<ReportOrderRow> = {}): ReportOrderRow {
  return {
    status: 'completed',
    amount_cents: 600,
    created_at: '2026-08-27T02:00:00.000Z',
    paid_at: '2026-08-27T02:01:30.000Z',
    settled_by: 'cron',
    ...overrides,
  };
}

const RANGE = resolveShanghaiDayRange(Date.parse('2026-08-27T02:00:00.000Z'));

describe('resolveShanghaiDayRange', () => {
  it('cuts the day at CST midnight, not UTC midnight', () => {
    // CST 08-27 07:30 → 当天区间是 UTC 08-26T16:00 起算的那 24 小时
    const range = resolveShanghaiDayRange(Date.parse('2026-08-26T23:30:00.000Z'));

    expect(range).toEqual({
      label: '2026-08-27',
      since: '2026-08-26T16:00:00.000Z',
      until: '2026-08-27T16:00:00.000Z',
    });
  });

  it('keeps a late-evening CST order inside the same day', () => {
    // CST 08-27 23:59 仍属 08-27，UTC 已经是 08-27T15:59
    const range = resolveShanghaiDayRange(Date.parse('2026-08-27T15:59:00.000Z'));

    expect(range.label).toBe('2026-08-27');
  });

  it('walks back whole days for the daysAgo argument', () => {
    const range = resolveShanghaiDayRange(Date.parse('2026-08-27T02:00:00.000Z'), 1);

    expect(range).toEqual({
      label: '2026-08-26',
      since: '2026-08-25T16:00:00.000Z',
      until: '2026-08-26T16:00:00.000Z',
    });
  });
});

describe('buildPaymentCallbackReport', () => {
  it('reports every settlement path, including the ones with no orders', () => {
    const report = buildPaymentCallbackReport([row({ settled_by: 'cron' })], RANGE);

    expect(report.sources.map((stat) => stat.source)).toEqual([
      'webhook',
      'return',
      'query',
      'cron',
    ]);
    expect(report.sources.find((stat) => stat.source === 'webhook')).toMatchObject({
      orders: 0,
      share: 0,
      avgSettleSeconds: null,
    });
  });

  it('splits share across paths and averages settle time per path', () => {
    const report = buildPaymentCallbackReport(
      [
        row({
          settled_by: 'query',
          paid_at: '2026-08-27T02:00:20.000Z',
        }),
        row({
          settled_by: 'cron',
          paid_at: '2026-08-27T02:01:00.000Z',
        }),
        row({
          settled_by: 'cron',
          paid_at: '2026-08-27T02:02:00.000Z',
          amount_cents: 2800,
        }),
      ],
      RANGE
    );

    const cron = report.sources.find((stat) => stat.source === 'cron');
    const query = report.sources.find((stat) => stat.source === 'query');

    expect(report.completedOrders).toBe(3);
    expect(report.completedAmountCents).toBe(4000);
    expect(cron).toMatchObject({
      orders: 2,
      amountCents: 3400,
      avgSettleSeconds: 90,
      maxSettleSeconds: 120,
    });
    expect(query?.share).toBeCloseTo(1 / 3);
  });

  it('counts unsettled orders in the status breakdown but not in the path split', () => {
    const report = buildPaymentCallbackReport(
      [
        row({ settled_by: 'return' }),
        row({ status: 'pending', paid_at: null, settled_by: null }),
        row({ status: 'expired', paid_at: null, settled_by: null }),
      ],
      RANGE
    );

    expect(report.createdOrders).toBe(3);
    expect(report.completedOrders).toBe(1);
    expect(report.completionRate).toBeCloseTo(1 / 3);
    expect(report.statusCounts).toEqual({ pending: 1, completed: 1, expired: 1, failed: 0 });
    expect(report.sources.reduce((total, stat) => total + stat.orders, 0)).toBe(1);
  });

  it('keeps pre-101 orders in a separate unknown bucket', () => {
    const report = buildPaymentCallbackReport(
      [row({ settled_by: null }), row({ settled_by: 'webhook' })],
      RANGE
    );

    const unknown = report.sources.find((stat) => stat.source === 'unknown');

    expect(unknown).toMatchObject({ orders: 1, share: 0.5 });
    expect(report.sources.find((stat) => stat.source === 'webhook')?.orders).toBe(1);
  });

  it('omits the unknown bucket once every order carries a path', () => {
    const report = buildPaymentCallbackReport([row({ settled_by: 'query' })], RANGE);

    expect(report.sources.some((stat) => stat.source === 'unknown')).toBe(false);
  });

  it('survives a day with no orders at all', () => {
    const report = buildPaymentCallbackReport([], RANGE);

    expect(report).toMatchObject({ createdOrders: 0, completedOrders: 0, completionRate: 0 });
    expect(report.sources.every((stat) => stat.orders === 0)).toBe(true);
  });
});

describe('formatPaymentCallbackReport', () => {
  it('renders one line per path with share and settle time', () => {
    const output = formatPaymentCallbackReport(
      buildPaymentCallbackReport(
        [row({ settled_by: 'cron', paid_at: '2026-08-27T02:01:30.000Z' })],
        RANGE
      )
    );

    expect(output).toContain('支付回调日报 2026-08-27 (CST)');
    expect(output).toMatch(/cron\s+1\s+100\.0%\s+90\.0s/);
    expect(output).toMatch(/webhook\s+0\s+0\.0%\s+-/);
  });

  it('says so plainly when nothing was credited', () => {
    const output = formatPaymentCallbackReport(buildPaymentCallbackReport([], RANGE));

    expect(output).toContain('当天没有已入账订单。');
  });

  it('lines the CJK header up with the data columns', () => {
    const lines = formatPaymentCallbackReport(
      buildPaymentCallbackReport([row({ settled_by: 'cron' })], RANGE)
    ).split('\n');
    const header = lines.find((line) => line.startsWith('入账路径'));
    const dataRow = lines.find((line) => line.startsWith('cron'));

    expect(header).toBeDefined();
    expect(dataRow).toBeDefined();
    expect(displayWidth(header as string)).toBe(displayWidth(dataRow as string));
  });
});

/** 终端里 CJK 占两列，对齐要按显示宽度算而不是按字符数。 */
function displayWidth(text: string): number {
  return [...text].reduce((width, char) => width + (/[\u2E80-\uFFEF]/.test(char) ? 2 : 1), 0);
}
