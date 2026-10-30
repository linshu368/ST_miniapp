import * as Sentry from '@sentry/nextjs';

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

/** Tracing starts after first-screen work; error capture and Metrics stay active from init. */
export function installDeferredTracing(): void {
  if (!Sentry.getClient() || Sentry.getClient()?.getIntegrationByName('BrowserTracing')) return;
  Sentry.addIntegration(Sentry.browserTracingIntegration({ shouldCreateSpanForRequest }));
}
