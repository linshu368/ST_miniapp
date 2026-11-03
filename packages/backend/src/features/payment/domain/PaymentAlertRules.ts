import { randomUUID } from 'node:crypto';
import type { AlertEvaluation, AlertSeverity } from '@miniapp/shared';

/**
 * v3：只看支付平台直接给出的信号（建单错误码、平台订单状态、Webhook 验签结果），
 * 不再从“用户打开过收银台却没付成”去推测故障——那是老供应商查不到任何状态时的权宜做法。
 */
export const PAYMENT_ALERT_RULE_VERSION = 'v3';

export type PaymentOperation = {
  event_kind: string;
  outcome: string;
  trigger: string;
  occurred_at: string;
  error_class: string | null;
  /** 建单、查单耗时；老事件和不计时的事件为空。 */
  duration_ms?: number | null;
  order_id: string | null;
  user_id: string | null;
};

export interface PaymentAlertSnapshot {
  /** 最近 60 分钟的支付操作事件，按 occurred_at 升序。 */
  operations: PaymentOperation[];
}

export const P0_PROVIDER_CREATE_FAILING_RULE_ID = 'p0-provider-create-failing';
export const P0_PAID_NOT_FULFILLED_RULE_ID = 'p0-paid-not-fulfilled';
export const P1_REFUND_RULE_ID = 'p1-refund';
export const P1_PROVIDER_QUERY_FAILING_RULE_ID = 'p1-provider-query-failing';
export const P1_WEBHOOK_REJECTED_RULE_ID = 'p1-webhook-rejected';
/** 预警：平台变慢或开始间歇失败，还没到用户连续建单失败的程度。 */
export const P1_PROVIDER_DEGRADED_RULE_ID = 'p1-provider-degraded';

/** 单次建单/查单超过这个耗时就算“慢”（建单目标 P95 ≤ 3 秒）。 */
export const SLOW_CALL_MS = 3_000;
/** 对账循环把成功但偏慢的查单记成这个分类，供预警规则统计。 */
export const SLOW_CALL_ERROR_CLASS = 'slow';

/**
 * 会推送飞书的规则：用户付不了钱、付了钱没拿到权益、钱被退回，
 * 以及平台还没让用户出错之前的预警（查单探测失败、平台变慢或间歇失败）。其余只记事故。
 */
export const FEISHU_NOTIFY_RULE_IDS = new Set([
  P0_PROVIDER_CREATE_FAILING_RULE_ID,
  P0_PAID_NOT_FULFILLED_RULE_ID,
  P1_REFUND_RULE_ID,
  P1_PROVIDER_QUERY_FAILING_RULE_ID,
  P1_PROVIDER_DEGRADED_RULE_ID,
]);

/** 平台说已付款、本地却没入账的错误分类（不论来自 Webhook 还是对账）。 */
const PAID_ANOMALY_CLASSES = new Set(['currency_mismatch', 'provider_ref_mismatch']);
/** 对账发现的单据异常不是“查单接口坏了”，不计入查单失败率。 */
const LOOKUP_ANOMALY_CLASSES = new Set([
  'provider_not_found',
  'provider_ref_mismatch',
  'currency_mismatch',
]);
const WEBHOOK_REJECTED_CLASSES = new Set([
  'signature_invalid',
  'stale_timestamp',
  'not_configured',
]);
const QUERY_EVENT_KINDS = new Set(['payment_query', 'fast_reconcile', 'expiry_reconcile']);

const ERROR_LABELS: Record<string, string> = {
  method_maintenance: '渠道维护',
  provider_unavailable: '平台不可用',
  configuration: '密钥/账户配置错误',
  rate_limited: '被限流',
  provider_rejected: '平台拒单',
  response_invalid: '平台响应异常',
  timeout: '超时',
  network: '网络错误',
  provider_ref_persist_failed: '平台单号写库失败',
  settlement_failed: '本地履约失败',
  amount_mismatch: '金额不符',
  currency_mismatch: '币种不符',
  provider_ref_mismatch: '交易号不符',
  order_not_found: '本地订单不存在',
  refund: '退款',
  chargeback: '拒付',
};

type Rule = {
  id: string;
  severity: AlertSeverity;
  windowMs: number;
  firing: boolean;
  metrics: Array<[string, number, 'count' | 'ratio' | 'milliseconds']>;
  location: AlertEvaluation['location'];
  title: string;
  summary?: string;
  recommendedAction: string;
};

/** Pure evaluator. It deliberately emits one independently-versioned evaluation per rule. */
export function evaluatePaymentAlertRules(
  snapshot: PaymentAlertSnapshot,
  now = new Date()
): AlertEvaluation[] {
  const nowMs = now.getTime();
  const within = (ms: number, filter: (op: PaymentOperation) => boolean) =>
    snapshot.operations.filter((op) => {
      const at = Date.parse(op.occurred_at);
      return at >= nowMs - ms && at <= nowMs && filter(op);
    });

  const creates = within(10 * 60_000, (op) => op.event_kind === 'gateway_create');
  const createFailures = creates.filter((op) => op.outcome === 'failed');
  const createBlocked =
    createFailures.length >= 3 && creates.slice(-3).every((op) => op.outcome === 'failed');

  const unresolvedPaid = unresolvedPaidAnomalies(snapshot.operations, nowMs);

  const refunds = within(
    60 * 60_000,
    (op) =>
      op.event_kind === 'webhook' &&
      op.outcome === 'failed' &&
      (op.error_class === 'refund' || op.error_class === 'chargeback')
  );

  const queries = within(
    10 * 60_000,
    (op) =>
      QUERY_EVENT_KINDS.has(op.event_kind) &&
      op.outcome !== 'skipped' &&
      !LOOKUP_ANOMALY_CLASSES.has(op.error_class ?? '') &&
      op.error_class !== SLOW_CALL_ERROR_CLASS
  );
  const queryFailures = queries.filter((op) => op.outcome === 'failed');

  const webhookRejected = within(
    10 * 60_000,
    (op) =>
      op.event_kind === 'webhook' &&
      op.outcome === 'failed' &&
      WEBHOOK_REJECTED_CLASSES.has(op.error_class ?? '')
  );

  // 预警：建单间歇失败（还没连续 3 次）或平台整体变慢。P0 已触发时不重复预警。
  const createFailureRatio = ratio(createFailures.length, creates.length);
  const intermittentCreateFailures =
    !createBlocked && createFailures.length >= 2 && createFailureRatio >= 0.4;
  const slowCreates = creates.filter(
    (op) => op.outcome !== 'failed' && (op.duration_ms ?? 0) >= SLOW_CALL_MS
  );
  const slowProbes = within(
    10 * 60_000,
    (op) => QUERY_EVENT_KINDS.has(op.event_kind) && op.error_class === SLOW_CALL_ERROR_CLASS
  );
  const slowCalls = slowCreates.length + slowProbes.length;
  const degraded = intermittentCreateFailures || slowCalls >= 3;
  const degradedReasons = [
    intermittentCreateFailures
      ? `建单 ${creates.length} 次失败 ${createFailures.length} 次（${describeClasses(createFailures)}）`
      : '',
    slowCalls >= 3
      ? `慢调用 ${slowCalls} 次（建单 ${slowCreates.length}、查单 ${slowProbes.length}，阈值 ${SLOW_CALL_MS / 1000} 秒）`
      : '',
  ].filter(Boolean);

  const rules: Rule[] = [
    {
      id: P0_PROVIDER_CREATE_FAILING_RULE_ID,
      severity: 'P0',
      windowMs: 10 * 60_000,
      firing: createBlocked,
      metrics: [
        ['provider_create_attempts', creates.length, 'count'],
        ['failure_ratio', ratio(createFailures.length, creates.length), 'ratio'],
      ],
      location: { kind: 'dependency', component: 'provider_create' },
      title: 'P0 支付平台建单连续失败',
      summary: `最近 10 分钟建单 ${creates.length} 次，失败 ${createFailures.length} 次：${describeClasses(createFailures)}`,
      recommendedAction:
        '按错误分类处理：渠道维护/平台不可用看 Vexutopia 控制台；配置错误检查 VEXUTOPIA_API_KEY；写库失败查数据库。',
    },
    {
      id: P0_PAID_NOT_FULFILLED_RULE_ID,
      severity: 'P0',
      windowMs: 10 * 60_000,
      firing: unresolvedPaid.length > 0,
      // 指标名不能含 order/key/token 等词：告警卡片安全策略会整张拒发（safe-card.ts）。
      metrics: [['unresolved_count', unresolvedPaid.length, 'count']],
      location: { kind: 'application', component: 'local_settlement' },
      title: 'P0 平台已收款但未发放权益',
      summary: unresolvedPaid
        .slice(0, 5)
        .map((op) => `【订单】${op.order_id ?? '未知'}（${label(op.error_class)}）`)
        .join('\n'),
      recommendedAction: '按订单号核对平台单据与本地订单，修复后用对账任务或 resend-webhook 补发。',
    },
    {
      id: P1_REFUND_RULE_ID,
      severity: 'P1',
      windowMs: 60 * 60_000,
      firing: refunds.length > 0,
      metrics: [['refund_events', refunds.length, 'count']],
      location: { kind: 'dependency', component: 'provider_refund' },
      title: 'P1 支付平台发生退款或拒付',
      summary: refunds
        .slice(0, 5)
        .map((op) => `【订单】${op.order_id ?? '未知'}（${label(op.error_class)}）`)
        .join('\n'),
      recommendedAction: '人工确认是否需要收回已发放的会员或星尘。',
    },
    {
      id: P1_PROVIDER_QUERY_FAILING_RULE_ID,
      severity: 'P1',
      windowMs: 10 * 60_000,
      firing: queryFailures.length >= 3 && ratio(queryFailures.length, queries.length) > 0.8,
      metrics: [
        ['query_attempts', queries.length, 'count'],
        ['query_failure_ratio', ratio(queryFailures.length, queries.length), 'ratio'],
      ],
      location: { kind: 'dependency', component: 'provider_query' },
      title: 'P1 支付平台查单接口异常',
      summary: `最近 10 分钟查单 ${queries.length} 次，失败 ${queryFailures.length} 次：${describeClasses(queryFailures)}`,
      recommendedAction: '查单失败期间只能靠 Webhook 入账；检查平台状态与 API Key。',
    },
    {
      id: P1_PROVIDER_DEGRADED_RULE_ID,
      severity: 'P1',
      windowMs: 10 * 60_000,
      firing: degraded,
      metrics: [
        ['create_failures', createFailures.length, 'count'],
        ['create_failure_ratio', createFailureRatio, 'ratio'],
        ['slow_calls', slowCalls, 'count'],
      ],
      location: { kind: 'dependency', component: 'provider_health' },
      title: 'P1 支付平台不稳定（预警）',
      summary: `用户尚未连续失败，但平台已出现异常：${degradedReasons.join('；')}`,
      recommendedAction:
        '先看 Vexutopia 控制台和状态页；趋势继续恶化会升级为建单连续失败。必要时在后台临时关闭受影响的渠道。',
    },
    {
      id: P1_WEBHOOK_REJECTED_RULE_ID,
      severity: 'P1',
      windowMs: 10 * 60_000,
      firing: webhookRejected.length >= 3,
      metrics: [['rejected_webhooks', webhookRejected.length, 'count']],
      location: { kind: 'delivery_path', component: 'webhook' },
      title: 'P1 支付回调验签失败',
      summary: `最近 10 分钟 ${webhookRejected.length} 次回调被拒`,
      recommendedAction: '检查 VEXUTOPIA_WEBHOOK_SECRET 是否与本环境注册的端点一致。',
    },
  ];
  return rules.map((r) => evaluation(r, now));
}

/**
 * 10 分钟内出现的“已付款未入账”事实，且同一订单之后没有入账成功。
 * 看 60 分钟内的入账成功，是为了让迟到的补账能把告警自动恢复。
 */
function unresolvedPaidAnomalies(
  operations: PaymentOperation[],
  nowMs: number
): PaymentOperation[] {
  const settledAt = new Map<string, number>();
  for (const op of operations) {
    if (op.event_kind === 'settlement' && op.outcome === 'succeeded' && op.order_id) {
      settledAt.set(
        op.order_id,
        Math.max(settledAt.get(op.order_id) ?? 0, Date.parse(op.occurred_at))
      );
    }
  }
  const seen = new Set<string>();
  return operations.filter((op) => {
    const at = Date.parse(op.occurred_at);
    if (at < nowMs - 10 * 60_000 || at > nowMs || op.outcome !== 'failed') return false;
    const paidAnomaly =
      op.event_kind === 'settlement' || PAID_ANOMALY_CLASSES.has(op.error_class ?? '');
    if (!paidAnomaly) return false;
    const key = op.order_id ?? `unknown:${op.occurred_at}`;
    if (seen.has(key)) return false;
    if (op.order_id && (settledAt.get(op.order_id) ?? 0) > at) return false;
    seen.add(key);
    return true;
  });
}

function describeClasses(operations: PaymentOperation[]): string {
  const counts = new Map<string, number>();
  for (const op of operations) {
    const name = label(op.error_class);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => `${name}×${count}`).join('、') || '无';
}

function label(errorClass: string | null): string {
  return errorClass ? (ERROR_LABELS[errorClass] ?? errorClass) : '未分类';
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
    // 规则只读平台明确给出的结果，没有推测成分。
    confidence: 'confirmed',
    observed_at: ended,
    window_started_at: new Date(now.getTime() - rule.windowMs).toISOString(),
    window_ended_at: ended,
    title: rule.title,
    summary: rule.firing
      ? boundText(rule.summary || '支付监控规则满足触发条件', 500)
      : '支付监控窗口健康',
    metrics: rule.metrics.map(([name, value, unit]) => ({ name, value, unit })),
    samples: [],
    recommended_action: rule.recommendedAction,
  };
}

function boundText(value: string, max: number): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function ratio(a: number, b: number) {
  return b === 0 ? 0 : a / b;
}

function environment(): AlertEvaluation['environment'] {
  const e = process.env.NODE_ENV;
  return e === 'production' || e === 'test' || e === 'preview' ? e : 'development';
}
