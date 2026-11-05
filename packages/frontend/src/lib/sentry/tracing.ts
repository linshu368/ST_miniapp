import * as Sentry from '@sentry/nextjs';

/** Faro 上报请求不进 BrowserTracing，避免上报本身撑开 navigation P95。 */
function shouldCreateSpanForRequest(url: string): boolean {
  const grafanaCollector = process.env.NEXT_PUBLIC_GRAFANA_COLLECTOR_URL?.trim();
  return !(grafanaCollector && url.startsWith(grafanaCollector));
}

/** Tracing starts after first-screen work; error capture and Metrics stay active from init. */
export function installDeferredTracing(): void {
  if (!Sentry.getClient() || Sentry.getClient()?.getIntegrationByName('BrowserTracing')) return;
  Sentry.addIntegration(Sentry.browserTracingIntegration({ shouldCreateSpanForRequest }));
}
