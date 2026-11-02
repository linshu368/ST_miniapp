'use client';

import { useEffect, useRef } from 'react';
import { useLobbyExposureMutation } from '@/lib/api/lobby-recommendations';

/** Observe rendered cards, never the response/preloaded catalogue. */
export function useLobbyExposures({
  enabled,
  scope,
  batchId,
  characterIds,
}: {
  enabled: boolean;
  scope: string;
  batchId: string | null | undefined;
  characterIds: string[];
}) {
  const { mutate } = useLobbyExposureMutation();
  const seen = useRef(new Map<string, Set<string>>());
  const idsKey = characterIds.join(',');

  useEffect(() => {
    if (!enabled || !batchId || typeof IntersectionObserver === 'undefined') return;
    const key = `${scope}:${batchId}`;
    let recorded = seen.current.get(key);
    if (!recorded) {
      recorded = new Set();
      seen.current.set(key, recorded);
      if (seen.current.size > 8) seen.current.delete(seen.current.keys().next().value!);
    }
    const allowed = new Set(idsKey.split(','));
    const pending = new Set<string>();
    const timers = new Map<Element, ReturnType<typeof setTimeout>>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let observer: IntersectionObserver | undefined;
    const flush = () => {
      clearTimeout(flushTimer);
      flushTimer = undefined;
      const ids = [...pending];
      pending.clear();
      for (let i = 0; i < ids.length; i += 40)
        mutate({ scope, batch_id: batchId, character_ids: ids.slice(i, i + 40) });
    };
    const stop = () => {
      observer?.disconnect();
      observer = undefined;
      timers.forEach(clearTimeout);
      timers.clear();
    };
    const start = () => {
      stop();
      if (document.visibilityState !== 'visible') return;
      // Sticky chrome covers pixels too. A card behind the search bar/nav is not fully seen.
      const header = document.querySelector('nav[aria-label="角色栏目"]')?.closest('header');
      const navigation = document.querySelector('nav[aria-label="主导航"]');
      const top = Math.max(0, header?.getBoundingClientRect().bottom ?? 0);
      const bottom = Math.max(
        0,
        window.innerHeight - (navigation?.getBoundingClientRect().top ?? window.innerHeight)
      );
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.lobbyCharacterId;
            if (!id || !allowed.has(id) || recorded.has(id)) continue;
            if (!entry.isIntersecting || entry.intersectionRatio < 0.5) {
              clearTimeout(timers.get(entry.target));
              timers.delete(entry.target);
              continue;
            }
            if (timers.has(entry.target)) continue;
            timers.set(
              entry.target,
              setTimeout(() => {
                timers.delete(entry.target);
                if (document.visibilityState !== 'visible' || !entry.target.isConnected) return;
                recorded.add(id);
                pending.add(id);
                if (flushTimer === undefined) flushTimer = setTimeout(flush, 600);
              }, 1000)
            );
          }
        },
        { threshold: [0, 0.5], rootMargin: `-${top}px 0px -${bottom}px 0px` }
      );
      for (const element of document.querySelectorAll<HTMLElement>('[data-lobby-character-id]')) {
        if (allowed.has(element.dataset.lobbyCharacterId ?? '')) observer.observe(element);
      }
    };
    const visibility = () => {
      if (document.visibilityState === 'visible') start();
      else {
        stop();
        flush();
      }
    };
    start();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('resize', start);
    return () => {
      stop();
      flush();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('resize', start);
    };
  }, [batchId, enabled, idsKey, mutate, scope]);
}
