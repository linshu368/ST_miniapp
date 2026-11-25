'use client';

import { useEffect, useRef, useState } from 'react';

/** A previous SPA visit must not release this session's secondary readers. */
export function useChatContentPainted(sessionId: string | null, ready: boolean): boolean {
  const visit = useRef({ sessionId, ready, generation: 0 });
  if (visit.current.sessionId !== sessionId || visit.current.ready !== ready)
    visit.current = { sessionId, ready, generation: visit.current.generation + 1 };
  const generation = visit.current.generation;
  const [painted, setPainted] = useState(-1);
  useEffect(() => {
    if (!ready || !sessionId) return;
    let second: number | undefined;
    let cancelled = false;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        if (!cancelled) setPainted(generation);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(first);
      if (second !== undefined) cancelAnimationFrame(second);
    };
  }, [sessionId, ready, generation]);
  return ready && sessionId !== null && painted === generation;
}
