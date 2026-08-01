import * as Sentry from '@sentry/nextjs';

import { sanitizeTelemetry } from '@/lib/sentry/sanitize';

const SENTRY_ENVIRONMENTS = new Set(['production', 'development']);

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
const environment = process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT?.trim();

function isValidDsn(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export const isSentryEnabled = isValidDsn(dsn) && SENTRY_ENVIRONMENTS.has(environment ?? '');

if (isSentryEnabled) {
  Sentry.init({
    dsn,
    environment,
    tracesSampleRate: 1.0,
    replaysSessionSampleRate: 1.0,
    replaysOnErrorSampleRate: 1.0,
    enableLogs: true,
    initialScope: {
      tags: { service: 'frontend' },
    },
    beforeSend: (event) => sanitizeTelemetry(event),
    beforeSendTransaction: (event) => sanitizeTelemetry(event),
    beforeBreadcrumb: (breadcrumb) => sanitizeTelemetry(breadcrumb),
  });
  Sentry.addEventProcessor((event) =>
    event.type === 'replay_event' ? sanitizeTelemetry(event) : event
  );
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
