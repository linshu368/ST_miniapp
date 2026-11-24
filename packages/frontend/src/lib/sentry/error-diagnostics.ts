import type { ErrorEvent, EventHint } from '@sentry/nextjs';
import { engineeringRoute, toRouteTemplate } from '@/lib/perf/route-template';
import {
  coverResizeDiagnostic,
  requestFailureDiagnostic,
  telegramInitState,
} from './diagnostic-state';

/** Enrich the original event, preserving its exception, severity and grouping. */
export function enrichErrorDiagnostic(event: ErrorEvent, hint?: EventHint): ErrorEvent {
  try {
    const description = [
      event.message,
      ...(event.exception?.values?.flatMap((item) => [item.type, item.value]) ?? []),
    ].join(' ');
    const category = /TelegramGameProxy|receiveEvent/.test(description)
      ? 'telegram_bridge'
      : /ResizeObserver loop/.test(description)
        ? 'resize_observer'
        : /AbortError|Fetch is aborted|operation was aborted/i.test(description)
          ? 'request_abort'
          : undefined;
    if (!category || typeof window === 'undefined') return event;
    const request = requestFailureDiagnostic(hint?.originalException);
    const native = window as unknown as { TelegramGameProxy?: { receiveEvent?: unknown } };
    const root = document.documentElement;
    return {
      ...event,
      contexts: {
        ...event.contexts,
        st_failure_diagnostic: {
          version: 1,
          category,
          route: engineeringRoute(toRouteTemplate(window.location.pathname)),
          visibility: document.visibilityState,
          ...(category === 'telegram_bridge'
            ? {
                sdk_state: telegramInitState(),
                receiver_present: typeof native.TelegramGameProxy?.receiveEvent === 'function',
                html_ready: window.__miniappStartup?.status === 'sent',
              }
            : {}),
          ...(category === 'resize_observer'
            ? {
                ...coverResizeDiagnostic(),
                viewport_width: window.innerWidth,
                viewport_height: window.innerHeight,
                scroll_y: Math.round(window.scrollY),
                document_height: root.scrollHeight,
                document_width: root.scrollWidth,
                dialog_open: !!document.querySelector('[role="dialog"]'),
                observer_source: 'unattributed',
              }
            : {}),
          ...(category === 'request_abort'
            ? {
                correlation: request ? 'same_error_object' : 'unattributed',
                ...request,
              }
            : {}),
        },
      },
    };
  } catch {
    return event;
  }
}
