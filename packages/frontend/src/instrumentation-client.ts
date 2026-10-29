import * as Sentry from '@sentry/nextjs';

import { initEnvTags } from '@/lib/perf/env-tags';
import { initializeEngineeringTelemetry } from '@/lib/perf/grafana';
import { initializePageExperience, markPageNavigationStart } from '@/lib/perf/page-tracker';
import { sanitizeTelemetry } from '@/lib/sentry/sanitize';

const SENTRY_ENVIRONMENTS = new Set(['production', 'development']);

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
const environment = process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT?.trim();

// 采样初值（design §4），上线后按 Sentry 配额占用调整。
// p95/p99 来自 Sentry Metrics（全量），trace/Replay 只用来看单条请求和单次会话的细节。
// 卡顿事件（page_stall/action_stall/slow_request）是错误类事件，会触发 replaysOnErrorSampleRate 的缓冲回放，
// 所以不依赖会话采样也能回看。
const TRACES_SAMPLE_RATE = 0.2;
const REPLAY_SESSION_SAMPLE_RATE = 0.05;

void initializeEngineeringTelemetry();
initializePageExperience();

// 前端在 Vercel、后端在 Railway，跨域请求默认不带 sentry-trace，前后端 trace 串不起来。
function resolveTracePropagationTargets(): Array<string | RegExp> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (!apiUrl) return [];
  try {
    return [new URL(apiUrl).origin];
  } catch {
    return [];
  }
}

function isValidDsn(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/** PostHog 请求不进 BrowserTracing，避免 /flags、batch 撑开 navigation P95。 */
function shouldCreateSpanForRequest(url: string): boolean {
  if (/posthog/i.test(url)) return false;
  const grafanaCollector = process.env.NEXT_PUBLIC_GRAFANA_COLLECTOR_URL?.trim();
  if (grafanaCollector && url.startsWith(grafanaCollector)) return false;
  const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim();
  if (posthogHost) {
    try {
      const requestOrigin = new URL(
        url,
        typeof window !== 'undefined' ? window.location.href : undefined
      ).origin;
      if (requestOrigin === new URL(posthogHost).origin) return false;
    } catch {
      // ignore
    }
  }
  return true;
}

export const isSentryEnabled = isValidDsn(dsn) && SENTRY_ENVIRONMENTS.has(environment ?? '');

if (isSentryEnabled) {
  Sentry.init({
    dsn,
    environment,
    tracesSampleRate: TRACES_SAMPLE_RATE,
    tracePropagationTargets: resolveTracePropagationTargets(),
    integrations: (integrations) => {
      const withoutDefaultTracing = integrations.filter(
        (integration) => integration.name !== 'BrowserTracing'
      );
      return [
        ...withoutDefaultTracing,
        Sentry.browserTracingIntegration({
          shouldCreateSpanForRequest,
        }),
      ];
    },
    replaysSessionSampleRate: REPLAY_SESSION_SAMPLE_RATE,
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
  initEnvTags();
}

export const onRouterTransitionStart: typeof Sentry.captureRouterTransitionStart = (...args) => {
  markPageNavigationStart(args[0]);
  Sentry.captureRouterTransitionStart(...args);
};
