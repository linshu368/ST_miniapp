import * as Sentry from '@sentry/node';
import { sanitizeTelemetry } from '@miniapp/shared';

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
    tracesSampler: ({ name, inheritOrSampleWith }) => {
      if (name.includes('/health') || name.includes('/api/debug/')) return 0;
      if (name.includes('/api/bridge/st/')) return 0;
      if (name.includes('/api/platform/llm-proxy/v1/')) {
        return environment === 'production' ? 0.01 : 1;
      }
      return inheritOrSampleWith(1);
    },
    initialScope: {
      tags: { service: 'backend' },
    },
    beforeSend: (event) => sanitizeTelemetry(event),
    beforeSendTransaction: (event) => sanitizeTelemetry(event),
    beforeBreadcrumb: (breadcrumb) => sanitizeTelemetry(breadcrumb),
  });
}
