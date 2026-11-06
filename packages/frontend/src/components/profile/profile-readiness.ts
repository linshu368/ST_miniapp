'use client';

import { useEffect, useState, type RefObject } from 'react';
import type { QueryClient } from '@tanstack/react-query';

import { prefetchNotifications } from '@/lib/api/notifications';
import { canPrefetchInBackground } from '@/lib/background-prefetch';
import { afterEntryBackground } from '@/lib/entry-phase';
import {
  afterNavigationQuietWindow,
  useNavigationBackgroundAllowed,
} from '@/lib/navigation-quiet-window';

function useAfterFirstPaint(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let secondFrame: number | undefined;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => setReady(true));
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) window.cancelAnimationFrame(secondFrame);
    };
  }, []);
  return ready;
}

function useNearViewport(ref: RefObject<Element>, enabled: boolean): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!enabled || ready) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setReady(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setReady(true);
        observer.disconnect();
      },
      { rootMargin: '320px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, ready, ref]);
  return ready;
}

export function useProfileReadiness(ref: RefObject<Element>): {
  secondaryReadsReady: boolean;
  serviceEntriesReady: boolean;
} {
  const painted = useAfterFirstPaint();
  const navigationBackgroundAllowed = useNavigationBackgroundAllowed();
  const secondaryReadsReady = painted && navigationBackgroundAllowed;
  return {
    secondaryReadsReady,
    serviceEntriesReady: useNearViewport(ref, secondaryReadsReady),
  };
}

function afterProfileNavigationQuiet(): Promise<void> {
  return afterNavigationQuietWindow();
}

export function useProfileMessagePrefetch(
  queryClient: QueryClient,
  router: { prefetch: (href: string) => void },
  official: number,
  personal: number
): void {
  useEffect(() => {
    if (official === 0 && personal === 0) return;
    let active = true;
    void afterEntryBackground()
      .then(afterProfileNavigationQuiet)
      .then(() => {
        if (!active || !canPrefetchInBackground()) return;
        router.prefetch('/profile/messages');
        if (official > 0) void prefetchNotifications(queryClient, 'official');
        if (personal > 0) void prefetchNotifications(queryClient, 'personal');
      });
    return () => {
      active = false;
    };
  }, [official, personal, queryClient, router]);
}
