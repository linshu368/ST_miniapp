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
 * Sentry 有两种 webhook 形状，都兼容：
 * - 旧版 Alert Rule：{ action: 'triggered'|'resolved', data: { event: {...} } }
 * - 新版 Issue Alert：{ action: 'created'|'resolved', data: { issue: {...} } }
 */
type SentryPayload = {
  action?: string;
  data?: {
    event?: SentryEventLike;
    issue?: SentryEventLike;
    triggered_rule?: string;
  };
  installation?: unknown;
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
  resolved: 'healthy',
};

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
