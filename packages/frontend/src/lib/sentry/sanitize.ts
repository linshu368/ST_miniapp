import type { ErrorEvent } from '@sentry/nextjs';
import { STARTUP_DETAIL_FIELDS, STARTUP_STAGE_NAMES } from '@/lib/perf/startup-phases';

export { isSensitiveTelemetryKey, sanitizeTelemetry } from '@miniapp/shared';
export type { SanitizeTelemetryOptions } from '@miniapp/shared';

const STARTUP_METRIC_ATTRIBUTES = new Set([
  'route',
  'tg_platform',
  'net_type',
  'measurement',
  'telegram_ready',
  'outcome',
  'stage',
  'startup_bucket',
  'definition',
  'budget',
  'sentry.release',
  'sentry.environment',
  'sentry.sdk.name',
  'sentry.sdk.version',
]);
const STARTUP_STAGES = new Set<string>(STARTUP_STAGE_NAMES);

/** SDK 自动补充身份/Replay 信息后再过滤，保证启动分布只有有界统计维度。 */
export function sanitizeStartupMetric<
  T extends { name: string; attributes?: Record<string, unknown> },
>(metric: T): T {
  if (!metric.name.startsWith('startup.')) return metric;
  const attributes = Object.fromEntries(
    Object.entries(metric.attributes ?? {}).filter(([key]) => STARTUP_METRIC_ATTRIBUTES.has(key))
  );
  if (
    'stage' in attributes &&
    (typeof attributes.stage !== 'string' || !STARTUP_STAGES.has(attributes.stage))
  ) {
    delete attributes.stage;
  }
  return {
    ...metric,
    attributes,
  };
}

/** 慢启动事件也会被 SDK 合并用户、URL、breadcrumbs；只保留这条诊断需要的字段。 */
export function sanitizeStartupDiagnostic(event: ErrorEvent): ErrorEvent {
  if (event.message !== 'miniapp_startup_slow') return event;
  const allowedFields = new Set<string>(STARTUP_DETAIL_FIELDS);
  const details = Object.fromEntries(
    Object.entries(event.contexts?.startup ?? {}).filter(
      ([key, value]) =>
        allowedFields.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0
    )
  );
  const allowedTags = new Set([
    'route',
    'tg_platform',
    'net_type',
    'measurement',
    'telegram_ready',
    'startup_bucket',
    'definition',
  ]);
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    release: event.release,
    environment: event.environment,
    message: 'miniapp_startup_slow',
    level: 'info',
    fingerprint: ['miniapp_startup_slow'],
    tags: Object.fromEntries(
      Object.entries(event.tags ?? {}).filter(([key]) => allowedTags.has(key))
    ),
    contexts: { startup: details },
  };
}
