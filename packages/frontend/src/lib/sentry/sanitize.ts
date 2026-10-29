export { isSensitiveTelemetryKey, sanitizeTelemetry } from '@miniapp/shared';
export type { SanitizeTelemetryOptions } from '@miniapp/shared';

const STARTUP_METRIC_ATTRIBUTES = new Set([
  'route',
  'tg_platform',
  'net_type',
  'measurement',
  'telegram_ready',
  'outcome',
  'sentry.release',
  'sentry.environment',
  'sentry.sdk.name',
  'sentry.sdk.version',
]);

/** SDK 自动补充身份/Replay 信息后再过滤，保证启动分布只有有界统计维度。 */
export function sanitizeStartupMetric<
  T extends { name: string; attributes?: Record<string, unknown> },
>(metric: T): T {
  if (!metric.name.startsWith('startup.')) return metric;
  return {
    ...metric,
    attributes: Object.fromEntries(
      Object.entries(metric.attributes ?? {}).filter(([key]) => STARTUP_METRIC_ATTRIBUTES.has(key))
    ),
  };
}
