'use client';

import { useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { canPrefetchInBackground } from './background-prefetch';
import { afterEntryBackground } from './entry-phase';
import {
  afterNavigationQuietWindow,
  isNavigationBackgroundAllowed,
} from './navigation-quiet-window';

type Prefetch = (href: string) => void | Promise<void>;
const TTL_MS = 30_000;
const WINDOW_MS = 10_000;
const MAX_TARGETS = 8;
const warmed = new Map<string, number>();
let windowStarted = Number.NEGATIVE_INFINITY;
let windowCount = 0;

/** Route code only: a conversation GET can recover writes, so it must not be speculative. */
export function warmChatRoute(href: string, prefetch: Prefetch): boolean {
  if (!canPrefetchInBackground() || !isNavigationBackgroundAllowed()) return false;
  let target: URL;
  try {
    target = new URL(href, window.location.href);
  } catch {
    return false;
  }
  if (target.origin !== window.location.origin || !/^\/chat\/[^/]+$/.test(target.pathname))
    return false;
  const key = target.pathname + target.search;
  const now = Date.now();
  for (const [url, started] of warmed) if (now - started >= TTL_MS) warmed.delete(url);
  if (warmed.has(key)) return false;
  if (now - windowStarted >= WINDOW_MS) {
    windowStarted = now;
    windowCount = 0;
  }
  // Pointer movement over a long list must not turn into an unbounded download queue.
  if (windowCount >= 3) return false;
  if (warmed.size >= MAX_TARGETS) warmed.delete(warmed.keys().next().value!);
  warmed.set(key, now);
  windowCount += 1;
  try {
    void Promise.resolve(prefetch(key)).catch(() => {
      if (warmed.get(key) === now) warmed.delete(key);
    });
  } catch {
    warmed.delete(key);
    return false;
  }
  return true;
}

export function useChatRouteIntent(href: string): () => void {
  const router = useRouter();
  return useCallback(() => {
    warmChatRoute(href, (target) => router.prefetch(target));
  }, [href, router]);
}

/** Warm one likely destination only after the source page has released its own critical work. */
export function useChatRouteWarmup(href: string | null, ready: boolean): void {
  const router = useRouter();
  useEffect(() => {
    if (!ready || !href) return;
    let cancelled = false;
    let timer: number | undefined;
    let idle: number | undefined;
    const run = () => {
      if (!cancelled) warmChatRoute(href, (target) => router.prefetch(target));
    };
    const cancel = () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (idle !== undefined && window.cancelIdleCallback) window.cancelIdleCallback(idle);
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') cancel();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void afterEntryBackground()
      .then(afterNavigationQuietWindow)
      .then(() => {
        if (cancelled || !canPrefetchInBackground()) return;
        if (window.requestIdleCallback) idle = window.requestIdleCallback(run, { timeout: 1500 });
        else timer = window.setTimeout(run, 250);
      });
    return () => {
      cancel();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [href, ready, router]);
}

export function resetChatRouteWarmupForTest(): void {
  warmed.clear();
  windowStarted = Number.NEGATIVE_INFINITY;
  windowCount = 0;
}
