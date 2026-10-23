import * as Sentry from '@sentry/node';
import { sanitizeTelemetry } from '@miniapp/shared';

/** 初值；上线后按 Sentry 配额占用调整。 */
const TRACE_SAMPLE_RATE = 0.2;

const dsn = process.env.SENTRY_DSN?.trim();
const configuredEnvironment = process.env.SENTRY_ENVIRONMENT?.trim();
const environment =
  configuredEnvironment === 'production' || configuredEnvironment === 'development'
    ? configuredEnvironment
    : process.env.NODE_ENV === 'production'
      ? 'production'
      : 'development';

function isValidDsn(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export const isSentryEnabled = isValidDsn(dsn);

if (isSentryEnabled) {
  Sentry.init({
    dsn,
    environment,
    release: process.env.SENTRY_RELEASE ?? process.env.RAILWAY_GIT_COMMIT_SHA,
    enableLogs: true,
    // p95/p99 来自 Sentry Metrics（全量），trace 只用来看单条请求的细节，所以可以降采样。
    // 前端已采样的请求会随 sentry-trace 继承，保证一条链路要么全有要么全无。
    tracesSampler: ({ name, inheritOrSampleWith }) => {
      if (name.includes('/health')) return 0;
      return inheritOrSampleWith(TRACE_SAMPLE_RATE);
    },
    initialScope: {
      tags: { service: 'backend' },
    },
    beforeSend: (event) => sanitizeTelemetry(event),
    beforeSendTransaction: (event) => sanitizeTelemetry(event),
    beforeBreadcrumb: (breadcrumb) => sanitizeTelemetry(breadcrumb),
  });
}
