export interface EarlyStartup {
  startedAt: number;
  shellAt?: number;
  readyAt?: number;
  status?: 'sent' | 'unavailable' | 'failed';
  outcome?: 'shell_ready' | 'background' | 'left' | 'missing_shell';
}

declare global {
  interface Window {
    __miniappStartup?: EarlyStartup;
  }
}

/** Serialized into HTML: keep this function self-contained, with no runtime imports. */
function bootstrapStartupShell(): void {
  if (window.__miniappStartup) return;
  const pathname = window.location.pathname;
  // Only these routes already have an equivalent, independently verified HTML frame.
  // Other entries keep their existing post-hydration readiness contract.
  if (pathname !== '/' && pathname !== '/characters' && pathname !== '/dramas') return;
  const state: EarlyStartup = { startedAt: performance.now() };
  window.__miniappStartup = state;
  const protectLaunchContext = (event: MouseEvent) => {
    if (!document.querySelector('[data-startup-content]')) {
      document.removeEventListener('click', protectLaunchContext, true);
      return;
    }
    // Before hydration an anchor would perform a document navigation, losing launch
    // context before the SDK can retain it. This HTML frame is display-only.
    if (event.target instanceof Element && event.target.closest('[data-startup-shell] a')) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  document.addEventListener('click', protectLaunchContext, true);
  let frame = 0;
  let stopped = false;
  const hidden = () => {
    if (document.hidden && !state.outcome) state.outcome = 'background';
  };
  const cleanup = () => {
    stopped = true;
    window.cancelAnimationFrame(frame);
    document.removeEventListener('visibilitychange', hidden);
    window.removeEventListener('pagehide', leave);
  };
  const leave = () => {
    if (!state.outcome) state.outcome = 'left';
    cleanup();
  };
  const visible = (element: Element | null): boolean => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0'
    );
  };
  const shellVisible = () => {
    // The CSS token distinguishes the styled frame from unstyled HTML. The inner marker
    // and navigation check avoid declaring an empty min-height wrapper ready.
    return (
      Boolean(getComputedStyle(document.documentElement).getPropertyValue('--app-nav-height')) &&
      visible(document.querySelector('[data-startup-content] main')) &&
      visible(document.querySelector('[data-startup-content]')) &&
      visible(document.querySelector('[data-startup-shell] nav[aria-label="主导航"]'))
    );
  };
  const notify = (): 'sent' | 'unavailable' | 'failed' => {
    try {
      const params = new URLSearchParams(
        window.location.search.slice(1) + '&' + window.location.hash.slice(1)
      );
      if (!params.get('tgWebAppVersion') || !params.get('tgWebAppPlatform')) return 'unavailable';
      const native = window as Window & {
        TelegramWebviewProxy?: { postEvent: (name: string, data: string) => void };
        external?: External & { notify?: (message: string) => void };
      };
      // Same two native transports as @telegram-apps/bridge 2.11.0. Embedded web
      // Telegram clients retain the existing SDK fallback rather than a new message bridge.
      if (
        native.TelegramWebviewProxy &&
        typeof native.TelegramWebviewProxy.postEvent === 'function'
      ) {
        native.TelegramWebviewProxy.postEvent('web_app_ready', '{}');
      } else if (native.external && typeof native.external.notify === 'function') {
        native.external.notify('{"eventType":"web_app_ready"}');
      } else {
        return 'unavailable';
      }
      return 'sent';
    } catch {
      return 'failed';
    }
  };
  const check = () => {
    if (stopped) return;
    if (state.status === 'sent') {
      cleanup();
      return;
    }
    hidden();
    if (shellVisible()) {
      frame = window.requestAnimationFrame(() => {
        if (stopped) return;
        if (state.status === 'sent') {
          cleanup();
          return;
        }
        hidden();
        if (!shellVisible()) {
          frame = window.requestAnimationFrame(check);
          return;
        }
        state.shellAt = performance.now();
        state.status = notify();
        if (state.status === 'sent') state.readyAt = performance.now();
        if (!state.outcome) state.outcome = 'shell_ready';
        cleanup();
      });
    } else if (performance.now() - state.startedAt < 15_000) {
      frame = window.requestAnimationFrame(check);
    } else {
      // The Providers path still owns readiness on unsupported/deep entry routes.
      cleanup();
    }
  };
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('pagehide', leave);
  hidden();
  frame = window.requestAnimationFrame(check);
}

// A raw inline script executes while parsing HTML, independently of Next's script queue.
// It only reads DOM and writes this bounded in-memory record; it never changes React's tree.
export const EARLY_STARTUP_SCRIPT = `(${bootstrapStartupShell.toString()})();`;
