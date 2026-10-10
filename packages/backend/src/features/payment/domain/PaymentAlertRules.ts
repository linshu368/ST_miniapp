import { randomUUID } from 'node:crypto';
import type { AlertEvaluation, AlertSeverity } from '@miniapp/shared';
import {
  aggregatePaymentAttempts,
  summarizePaymentAttempts,
  type PaymentAlertOrderSnapshot,
} from './PaymentAlertAggregation.js';

export const PAYMENT_ALERT_RULE_VERSION = 'v2';
export type PaymentOperation = {
  event_kind: string;
  outcome: string;
  trigger: string;
  occurred_at: string;
  error_class: string | null;
  order_id: string | null;
  user_id: string | null;
};
export interface PaymentAlertSnapshot {
  orders: PaymentAlertOrderSnapshot[];
  /**
   * 最近确认的订单，不按时间窗口截断。只给「连续未支付」使用，避免放宽 60 分钟扫描后改变 P1。
   * 缺省为空，规则不触发。
   */
  latestOrders?: PaymentAlertOrderSnapshot[];
  operations: PaymentOperation[];
  productionWebhookBaseline: boolean;
}
export const P0_USER_UNPAID_RULE_ID = 'p0-user-unpaid-5m';
export const P0_CONSECUTIVE_UNPAID_RULE_ID = 'p0-consecutive-unpaid';
/** 暂时只有这两条 P0 可以进入飞书。P1 仍会计算和记录事故，但不投递。 */
export const FEISHU_NOTIFY_RULE_IDS = new Set([
  P0_USER_UNPAID_RULE_ID,
  P0_CONSECUTIVE_UNPAID_RULE_ID,
]);
type Rule = {
  id: string;
  severity: AlertSeverity;
  windowMs: number;
  firing: boolean;
  metrics: Array<[string, number, 'count' | 'ratio' | 'milliseconds']>;
  location: AlertEvaluation['location'];
  confidence: AlertEvaluation['confidence'];
  title: string;
};

/** Pure V2 evaluator. It deliberately emits one independently-versioned evaluation per rule. */
export function evaluatePaymentAlertRules(
  snapshot: PaymentAlertSnapshot,
  now = new Date()
): AlertEvaluation[] {
  const nowMs = now.getTime();
  const inWindow = (ms: number) =>
    snapshot.orders.filter(
      (o) =>
        o.checkoutConfirmedAt &&
        Date.parse(o.checkoutConfirmedAt) >= nowMs - ms &&
        Date.parse(o.checkoutConfirmedAt) <= nowMs
    );
  const attempts15 = aggregatePaymentAttempts(inWindow(15 * 60_000));
  const a15 = summarizePaymentAttempts(attempts15.attempts, nowMs, 10 * 60_000);
  const ops = (kind: string, ms: number) =>
    snapshot.operations.filter(
      (o) =>
        o.event_kind === kind &&
        Date.parse(o.occurred_at) >= nowMs - ms &&
        Date.parse(o.occurred_at) <= nowMs
    );
  // P0-01 暂时停用，建单失败计数保留在下方注释中，恢复规则时一并恢复。
  const query10 = ops('payment_query', 10 * 60_000).filter((x) => x.outcome !== 'skipped');
  const queryFailed = query10.filter((x) => x.outcome === 'failed').length;
  // P0-04 暂时停用，本地结算失败计数保留在注释规则中。
  const completed60 = snapshot.orders.filter(
    (o) =>
      o.status === 'completed' &&
      o.fulfillmentApplied &&
      o.paidAt &&
      Date.parse(o.paidAt) >= nowMs - 60 * 60_000
  );
  const p95 = percentile(
    completed60.flatMap((o) =>
      o.checkoutConfirmedAt && o.paidAt && Date.parse(o.paidAt) >= Date.parse(o.checkoutConfirmedAt)
        ? [Date.parse(o.paidAt) - Date.parse(o.checkoutConfirmedAt)]
        : []
    ),
    0.95
  );
  const repeatUnpaid = countRepeatUnpaid(snapshot.orders, nowMs, 5 * 60_000);
  const consecutiveUnpaid = latestConsecutiveUnpaid(snapshot.latestOrders ?? []);
  const rules: Rule[] = [
    rule(
      P0_USER_UNPAID_RULE_ID,
      'P0',
      5,
      repeatUnpaid.users >= 1,
      [
        ['unpaid_count', repeatUnpaid.orders, 'count'],
        ['affected_users', repeatUnpaid.users, 'count'],
      ],
      { kind: 'unknown' },
      'suspected',
      '同一用户短时重复未支付'
    ),
    // 观察窗口记为 0：是否触发只看最近连续订单，不看它们相距多久。
    rule(
      P0_CONSECUTIVE_UNPAID_RULE_ID,
      'P0',
      0,
      consecutiveUnpaid,
      [['consecutive_count', consecutiveUnpaid ? 4 : 0, 'count']],
      { kind: 'unknown' },
      'suspected',
      '连续订单未支付成功'
    ),
    /*
    rule(
      'p0-01',
      'P0',
      5,
      create5.length >= 5 &&
        new Set(create5.map((x) => x.user_id).filter(Boolean)).size >= 2 &&
        createFailed / create5.length >= 0.5 &&
        create5.slice(-3).every((x) => x.outcome === 'failed'),
      [
        ['provider_create_attempts', create5.length, 'count'],
        ['failure_ratio', ratio(createFailed, create5.length), 'ratio'],
      ],
      { kind: 'dependency', component: 'provider_create' },
      'confirmed',
      '厂商建单阻断'
    ),
    rule(
      'p0-02',
      'P0',
      15,
      a15.attempts >= 5 &&
        a15.affectedUsers >= 3 &&
        a15.successfulAttempts === 0 &&
        a15.longPendingAttempts >= 3,
      [
        ['attempts', a15.attempts, 'count'],
        ['affected_users', a15.affectedUsers, 'count'],
      ],
      { kind: 'unknown' },
      'suspected',
      '多用户支付未成功'
    ),
    rule(
      'p0-03',
      'P0',
      15,
      a15.attempts >= 5 &&
        a15.affectedUsers >= 3 &&
        ratio(a15.suspectedFailedAttempts, a15.successfulAttempts + a15.suspectedFailedAttempts) >=
          0.5 &&
        a15.suspectedFailedAttempts >= 2,
      [
        ['attempts', a15.attempts, 'count'],
        [
          'suspected_failure_ratio',
          ratio(a15.suspectedFailedAttempts, a15.successfulAttempts + a15.suspectedFailedAttempts),
          'ratio',
        ],
      ],
      { kind: 'unknown' },
      'suspected',
      '支付疑似失败率过高'
    ),
    rule(
      'p0-04',
      'P0',
      5,
      settlementFailed.length >= 2 ||
        snapshot.orders.some(
          (o) =>
            o.paidAt &&
            nowMs - Date.parse(o.paidAt) > 60_000 &&
            (o.status !== 'completed' || !o.fulfillmentApplied)
        ),
      [['settlement_failures', settlementFailed.length, 'count']],
      { kind: 'application', component: 'local_settlement' },
      'confirmed',
      '已付款未履约'
    ),
    rule(
      'p0-05',
      'P0',
      10,
      a15.attempts >= 5 &&
        a15.affectedUsers >= 3 &&
        a15.successfulAttempts === 0 &&
        query10.length > 0 &&
        ratio(queryFailed, query10.length) > 0.8,
      [['query_failure_ratio', ratio(queryFailed, query10.length), 'ratio']],
      { kind: 'dependency', component: 'provider_query' },
      'suspected',
      '确认能力整体失效'
    ),
    */
    rule(
      'p1-01',
      'P1',
      10,
      (() => {
        const w = ops('webhook', 10 * 60_000);
        const trusted = w.filter((x) => x.error_class !== 'signature_invalid');
        return trusted.length >= 3 && trusted.some((x) => x.outcome === 'failed');
      })(),
      [['webhook_events', ops('webhook', 600_000).length, 'count']],
      { kind: 'delivery_path', component: 'webhook' },
      'suspected',
      'Webhook 处理异常'
    ),
    rule(
      'p1-02',
      'P1',
      60,
      snapshot.productionWebhookBaseline &&
        completed60.length >= 5 &&
        ratio(completed60.filter((o) => o.settledBy === 'webhook').length, completed60.length) <
          0.2 &&
        ratio(
          completed60.filter((o) => o.settledBy === 'query' || o.settledBy === 'cron').length,
          completed60.length
        ) >= 0.5,
      [
        ['completed', completed60.length, 'count'],
        [
          'webhook_settlement_ratio',
          ratio(completed60.filter((o) => o.settledBy === 'webhook').length, completed60.length),
          'ratio',
        ],
      ],
      { kind: 'delivery_path', component: 'webhook' },
      'suspected',
      'Webhook 投递疑似退化'
    ),
    rule(
      'p1-03',
      'P1',
      10,
      query10.length >= 10 && ratio(queryFailed, query10.length) >= 0.2,
      [
        ['query_attempts', query10.length, 'count'],
        ['failure_ratio', ratio(queryFailed, query10.length), 'ratio'],
      ],
      { kind: 'dependency', component: 'provider_query' },
      'confirmed',
      '主动查单失败率过高'
    ),
    rule(
      'p1-04',
      'P1',
      60,
      completed60.length >= 5 &&
        completed60.filter((o) => o.settledBy === 'cron').length / completed60.length >= 0.3,
      [['completed', completed60.length, 'count']],
      { kind: 'application', component: 'reconciliation' },
      'confirmed',
      '过度依赖后台对账'
    ),
    rule(
      'p1-05',
      'P1',
      60,
      completed60.length >= 5 && p95 > 180_000,
      [
        ['p95_confirmation_to_paid_ms', p95, 'milliseconds'],
        [
          'p95_excluded_count',
          completed60.length -
            completed60.filter(
              (o) =>
                o.checkoutConfirmedAt &&
                o.paidAt &&
                Date.parse(o.paidAt) >= Date.parse(o.checkoutConfirmedAt)
            ).length,
          'count',
        ],
      ],
      { kind: 'unknown' },
      'suspected',
      '确认到到账变慢'
    ),
    rule(
      'p1-06',
      'P1',
      15,
      a15.longPendingAttempts > 0 && !(a15.attempts >= 5 && a15.affectedUsers >= 3),
      [['long_pending_attempts', a15.longPendingAttempts, 'count']],
      { kind: 'unknown' },
      'suspected',
      '少量订单长时间等待'
    ),
  ];
  return rules.map((r) => evaluation(r, now));
}
function rule(
  id: string,
  severity: AlertSeverity,
  minutes: number,
  firing: boolean,
  metrics: Rule['metrics'],
  location: Rule['location'],
  confidence: Rule['confidence'],
  title: string
): Rule {
  return { id, severity, windowMs: minutes * 60_000, firing, metrics, location, confidence, title };
}
function evaluation(rule: Rule, now: Date): AlertEvaluation {
  const ended = now.toISOString();
  return {
    schema_version: 1,
    evaluation_id: randomUUID(),
    producer_run_id: randomUUID(),
    domain: 'payment',
    service: 'payment_alert_monitor',
    environment: environment(),
    rule_id: rule.id,
    rule_version: PAYMENT_ALERT_RULE_VERSION,
    rule_group: rule.id,
    fingerprint: `${environment()}:payment:${rule.id}:all`,
    state: rule.firing ? 'firing' : 'healthy',
    severity: rule.severity,
    location: rule.location,
    confidence: rule.confidence,
    observed_at: ended,
    window_started_at: new Date(now.getTime() - rule.windowMs).toISOString(),
    window_ended_at: ended,
    title: rule.title,
    summary: rule.firing ? '支付监控规则满足触发条件' : '支付监控窗口健康',
    metrics: rule.metrics.map(([name, value, unit]) => ({ name, value, unit })),
    samples: [],
    recommended_action: '核对支付事件聚合与支付服务日志。',
  };
}
function countRepeatUnpaid(
  orders: PaymentAlertOrderSnapshot[],
  nowMs: number,
  windowMs: number
): { users: number; orders: number } {
  const unpaidByUser = new Map<string, number>();
  for (const order of orders) {
    const confirmedAt = confirmationMs(order);
    if (
      !order.userId ||
      confirmedAt === null ||
      confirmedAt < nowMs - windowMs ||
      confirmedAt > nowMs
    )
      continue;
    if (paidSuccessfully(order)) continue;
    unpaidByUser.set(order.userId, (unpaidByUser.get(order.userId) ?? 0) + 1);
  }
  let users = 0;
  let unpaidOrders = 0;
  for (const count of unpaidByUser.values()) {
    if (count < 2) continue;
    users += 1;
    unpaidOrders += count;
  }
  return { users, orders: unpaidOrders };
}

/** 最近 4 笔已确认订单全部未支付成功。不足 4 笔不触发，中间隔了多久不参与判断。 */
function latestConsecutiveUnpaid(orders: PaymentAlertOrderSnapshot[]): boolean {
  const latest = orders
    .filter((order) => confirmationMs(order) !== null)
    .sort(
      (a, b) =>
        (confirmationMs(b) ?? 0) - (confirmationMs(a) ?? 0) || b.orderId.localeCompare(a.orderId)
    )
    .slice(0, 4);
  return latest.length === 4 && latest.every((order) => !paidSuccessfully(order));
}

function paidSuccessfully(order: PaymentAlertOrderSnapshot): boolean {
  return order.status === 'completed' || order.paidAt !== null;
}

function confirmationMs(order: PaymentAlertOrderSnapshot): number | null {
  if (!order.checkoutConfirmedAt) return null;
  const ms = Date.parse(order.checkoutConfirmedAt);
  return Number.isFinite(ms) ? ms : null;
}

function ratio(a: number, b: number) {
  return b === 0 ? 0 : a / b;
}
function percentile(v: number[], p: number) {
  if (!v.length) return 0;
  const x = [...v].sort((a, b) => a - b);
  return x[Math.min(x.length - 1, Math.ceil(x.length * p) - 1)]!;
}
function environment(): AlertEvaluation['environment'] {
  const e = process.env.NODE_ENV;
  return e === 'production' || e === 'test' || e === 'preview' ? e : 'development';
}
