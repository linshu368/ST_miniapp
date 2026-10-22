/**
 * Sentry 告警 → 现有告警信封的转换。
 *
 * 为什么不用 Sentry 原生集成：飞书没有官方集成，Sentry 也发不到飞书。改成
 * Sentry Alert 的 webhook 打到这里，复用已有的 outbox、重试、限流和飞书卡片
 * （features/alerting/），不新建投递链路。
 *
 * 转换必须是纯函数：事件顺序、去重、限流都在持久化层，这里只负责把 payload
 * 变成受约束的信封。任何字段都可能缺失，缺失时降级而不是抛错——告警系统自己
 * 崩掉比漏一条告警更糟。
 */
import type { AlertEvaluation } from '@miniapp/shared';

/**
 * Sentry 的 Internal Integration webhook 有三种形状，都兼容：
 * - 旧版 Alert Rule：{ action: 'triggered'|'resolved', data: { event: {...} } }
 * - 新版 Issue Alert：{ action: 'created'|'resolved', data: { issue: {...} } }
 * - Metric Alert：{ action: 'critical'|'warning'|'resolved', data: { metric_alert: {...} } }
 *
 * 5xx 比例、p95 这类信号只有 Metric Alert 能表达（Issue 报表产生不了 error event），
 * 所以第三种形状是主力，前两种只是兜底。
 */
type SentryPayload = {
  action?: string;
  data?: {
    event?: SentryEventLike;
    issue?: SentryEventLike;
    metric_alert?: SentryMetricAlertLike;
    triggered_rule?: string;
  };
  installation?: unknown;
};

type SentryMetricAlertLike = {
  id?: string | number;
  title?: string;
  alert_rule?: { id?: string | number; name?: string; aggregate?: string };
  date_started?: string;
  web_url?: string;
};

type SentryEventLike = {
  id?: string;
  title?: string;
  level?: string;
  web_url?: string;
  shortId?: string;
  timestamp?: string;
  datetime?: string;
  tags?: Array<{ key?: string; value?: string }> | Record<string, string>;
  culprit?: string;
  transaction?: string;
};

export interface SentryAlertContext {
  /** 服务端生成，保证同一事件的安全重试幂等。 */
  producerRunId: string;
  environment: AlertEvaluation['environment'];
}

export type SentryAlertConversion =
  | { kind: 'ok'; evaluation: AlertEvaluation }
  | { kind: 'ignored'; reason: 'not_an_alert' | 'unsupported_action' };

const ACTION_STATE: Record<string, AlertEvaluation['state']> = {
  triggered: 'firing',
  created: 'firing',
  // Metric Alert 的两档触发都算 firing，严重级别由规则名的前缀决定。
  critical: 'firing',
  warning: 'firing',
  resolved: 'healthy',
};

/** 规则名以 P0-/P1-/P2- 开头时，直接采用命名里的级别，避免两处判断不一致。 */
function severityFromRuleName(name: string | undefined): AlertEvaluation['severity'] | undefined {
  const match = name?.trim().match(/^(P[012])[\s:_-]/i);
  return match?.[1]?.toUpperCase() as AlertEvaluation['severity'] | undefined;
}

const PERF_EVENTS = new Set(['page_stall', 'action_stall', 'slow_request', 'asset_load_failed']);

/** 只允许安全字符，避免把用户 ID、URL 或任意字符串带进告警身份。 */
function slug(value: string, fallback: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9:_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return /^[a-z0-9][a-z0-9:_-]{2,191}$/.test(cleaned) ? cleaned : fallback;
}

function tagOf(event: SentryEventLike, key: string): string | undefined {
  const tags = event.tags;
  if (Array.isArray(tags)) return tags.find((t) => t?.key === key)?.value;
  if (tags && typeof tags === 'object') return tags[key];
  return undefined;
}

function eventTitle(event: SentryEventLike): string {
  // 我们自己的性能事件用 captureMessage，title 就是事件名；Issue 形态则用短 ID。
  return event.title?.trim() || event.shortId?.trim() || 'Sentry 告警';
}

/**
 * 性能事件（page_stall 等）与普通错误的严重级别不同：
 * 卡顿不阻断业务，按 P1 处理；错误默认 P1，只有崩溃类才升到 P0。
 */
function severityOf(
  perfEvent: string | undefined,
  level: string | undefined
): AlertEvaluation['severity'] {
  if (perfEvent) return perfEvent === 'asset_load_failed' ? 'P2' : 'P1';
  return level === 'fatal' ? 'P0' : 'P1';
}

export function convertSentryAlert(
  payload: unknown,
  ctx: SentryAlertContext
): SentryAlertConversion {
  const body = payload as SentryPayload | null;
  const action = body?.action;
  const state = action ? ACTION_STATE[action] : undefined;
  if (!action) return { kind: 'ignored', reason: 'not_an_alert' };
  if (!state) return { kind: 'ignored', reason: 'unsupported_action' };

  const metricAlert = body?.data?.metric_alert;
  if (metricAlert) {
    return convertMetricAlert(metricAlert, state, ctx);
  }

  const event = body?.data?.event ?? body?.data?.issue ?? {};
  const perfEvent = tagOf(event, 'perf_event');
  const route = tagOf(event, 'route');
  const actionName = tagOf(event, 'action');
  const domain = perfEvent ? 'experience' : 'errors';

  // fingerprint 必须稳定：同一类卡顿反复触发要合并成一条事故，而不是每条一个。
  // 刻意不含时间、事件 id 和用户，见 shared/src/api/alerting.ts 的约定。
  const subject = perfEvent
    ? (route ?? actionName ?? 'global')
    : slug(eventTitle(event), 'unknown-error');
  const fingerprint = `${ctx.environment}:${domain}:sentry:${perfEvent ?? 'issue'}:${slug(subject, 'global')}`;

  const title = perfEvent
    ? `体验告警 ${perfEvent}${route ? ` · ${route}` : actionName ? ` · ${actionName}` : ''}`
    : `Sentry ${eventTitle(event)}`;

  const observedAt = event.timestamp ?? event.datetime ?? new Date().toISOString();

  const evaluation: AlertEvaluation = {
    schema_version: 1,
    // 同一 action 的重复投递要幂等：注入的 id 由调用方按 payload 稳定生成。
    evaluation_id: ctx.producerRunId,
    producer_run_id: ctx.producerRunId,
    domain,
    service: 'miniapp',
    environment: ctx.environment,
    rule_id: slug(`sentry-${perfEvent ?? 'issue'}`, 'sentry-issue'),
    rule_version: '1',
    rule_group: 'experience',
    fingerprint,
    state,
    severity: severityOf(perfEvent, event.level),
    location: {
      kind: perfEvent ? 'application' : 'unknown',
      ...(route ? { component: slug(route, 'page') } : {}),
    },
    confidence: 'confirmed',
    observed_at: observedAt,
    window_started_at: observedAt,
    window_ended_at: observedAt,
    title: title.slice(0, 140),
    summary: (perfEvent
      ? `用户侧出现 ${perfEvent}${route ? `（页面 ${route}）` : ''}。`
      : `${eventTitle(event)}${event.culprit ? ` @ ${event.culprit}` : ''}`
    ).slice(0, 500),
    metrics: [],
    // 不带 URL（可能含参数）、不带用户 ID、不带原始报文。
    samples: [
      {
        kind: 'sentry_event',
        reference: slug(event.id ?? event.shortId ?? 'unknown', 'unknown-event').slice(0, 120),
        ...(event.transaction ? { summary: event.transaction.slice(0, 240) } : {}),
      },
    ],
    recommended_action: perfEvent
      ? '到 Sentry 按 perf_event 与 route 查对应事件，并查看该用户的 Replay。'
      : '到 Sentry 查看该 issue 的堆栈与最近事件。',
  };

  return { kind: 'ok', evaluation };
}

/**
 * Metric Alert 是 5xx 比例、p95、卡住人数这类聚合信号的唯一载体。
 * 它的 payload 不带 tags，所以身份只能来自规则名和 alert_rule.id：
 * 同一条规则反复触发必须合并成一条事故，否则每次触发都会刷一条飞书。
 */
function convertMetricAlert(
  alert: SentryMetricAlertLike,
  state: AlertEvaluation['state'],
  ctx: SentryAlertContext
): SentryAlertConversion {
  const ruleName = alert.alert_rule?.name ?? alert.title ?? 'Sentry 指标告警';
  // 规则名里带 stall 关键字时归为体验域，其余（5xx、p95）归为错误域。
  const isExperience = /stall|卡住|卡顿/i.test(ruleName);
  const domain = isExperience ? 'experience' : 'errors';
  const identity = slug(ruleName, `metric-${String(alert.alert_rule?.id ?? 'unknown')}`);
  const observedAt = alert.date_started ?? new Date().toISOString();

  return {
    kind: 'ok',
    evaluation: {
      schema_version: 1,
      evaluation_id: ctx.producerRunId,
      producer_run_id: ctx.producerRunId,
      domain,
      service: 'miniapp',
      environment: ctx.environment,
      rule_id: slug(`sentry-metric-${String(alert.alert_rule?.id ?? identity)}`, 'sentry-metric'),
      rule_version: '1',
      rule_group: 'experience',
      // 只含规则名与规则 id，不含时间、用户或任何 URL。
      fingerprint: `${ctx.environment}:${domain}:sentry:metric:${identity.slice(0, 160)}`,
      state,
      severity: severityFromRuleName(ruleName) ?? 'P1',
      location: { kind: 'application' },
      confidence: 'confirmed',
      observed_at: observedAt,
      window_started_at: observedAt,
      window_ended_at: observedAt,
      title: ruleName.slice(0, 140),
      summary: (alert.alert_rule?.aggregate
        ? `Sentry 指标告警触发：${alert.alert_rule.aggregate}。`
        : 'Sentry 指标告警触发。'
      ).slice(0, 500),
      metrics: [],
      samples: [],
      recommended_action: isExperience
        ? '到 Sentry 按 perf_event 与 route 查对应事件，并查看受影响用户的 Replay。'
        : '到 Sentry 打开该 Alert 看当前值与触发曲线，再回看同一时间窗的慢请求与错误。',
    },
  };
}
