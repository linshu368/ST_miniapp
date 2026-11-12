'use client';

import { useEffect } from 'react';
import { warmApiConnection } from '@/lib/api/connection-warmth';
import { warmDramaStreamOrigin } from '@/lib/drama-stream-origin';

/** Timeouts stop rising past this idle time, and it bounds pings on an abandoned page. */
const ACTIVE_WINDOW_MS = 5 * 60_000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'input', 'focusin', 'scroll'] as const;

/** Keeps one origin's connection warm while the page is visible and recently used. */
function useConnectionWarmth(warm: () => void, heartbeatMs: number): void {
  useEffect(() => {
    let lastActivityAt = performance.now();
    const warmIfVisible = () => {
      if (document.visibilityState === 'visible') warm();
    };
    const onActivity = () => {
      lastActivityAt = performance.now();
      warmIfVisible();
    };
    warmIfVisible();
    const heartbeat = window.setInterval(() => {
      if (performance.now() - lastActivityAt < ACTIVE_WINDOW_MS) warmIfVisible();
    }, heartbeatMs);
    for (const name of ACTIVITY_EVENTS)
      window.addEventListener(name, onActivity, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onActivity);
    return () => {
      window.clearInterval(heartbeat);
      for (const name of ACTIVITY_EVENTS)
        window.removeEventListener(name, onActivity, { capture: true });
      document.removeEventListener('visibilitychange', onActivity);
    };
  }, [warm, heartbeatMs]);
}

/** Below the API edge's 60s idle cutoff. */
const API_HEARTBEAT_MS = 45_000;

/** Chat only: a reply is the one request whose first second the user is watching. */
export function useApiConnectionWarmth(): void {
  useConnectionWarmth(warmApiConnection, API_HEARTBEAT_MS);
}

/** Well below the ~10s after which browsers drop an unused preconnected socket. */
const DRAMA_STREAM_HEARTBEAT_MS = 5_000;

/**
 * Drama pages only: with the master playlist inlined, the first Stream request is a child
 * playlist issued ~0.3s after the play intent — too soon for a handshake started at the intent.
 */
export function useDramaStreamWarmth(): void {
  useConnectionWarmth(warmDramaStreamOrigin, DRAMA_STREAM_HEARTBEAT_MS);
}
