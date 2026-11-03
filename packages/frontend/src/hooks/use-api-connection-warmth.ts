'use client';

import { useEffect } from 'react';
import { warmApiConnection } from '@/lib/api/connection-warmth';

/** Below the API edge's 60s idle cutoff. */
const HEARTBEAT_MS = 45_000;
/** Timeouts stop rising past this idle time, and it bounds pings on an abandoned page. */
const ACTIVE_WINDOW_MS = 5 * 60_000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'input', 'focusin', 'scroll'] as const;

/** Chat only: a reply is the one request whose first second the user is watching. */
export function useApiConnectionWarmth(): void {
  useEffect(() => {
    let lastActivityAt = performance.now();
    const warm = () => {
      if (document.visibilityState === 'visible') warmApiConnection();
    };
    const onActivity = () => {
      lastActivityAt = performance.now();
      warm();
    };
    warm();
    const heartbeat = window.setInterval(() => {
      if (performance.now() - lastActivityAt < ACTIVE_WINDOW_MS) warm();
    }, HEARTBEAT_MS);
    for (const name of ACTIVITY_EVENTS)
      window.addEventListener(name, onActivity, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onActivity);
    return () => {
      window.clearInterval(heartbeat);
      for (const name of ACTIVITY_EVENTS)
        window.removeEventListener(name, onActivity, { capture: true });
      document.removeEventListener('visibilitychange', onActivity);
    };
  }, []);
}
