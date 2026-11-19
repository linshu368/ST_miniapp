import { useCallback, useEffect, useRef } from 'react';
import {
  reportPlazaMetric,
  type PlazaDimensions,
  type PlazaOutcome,
} from '@/lib/perf/plaza-metrics';

/** The same entry owns success, background and leave; StrictMode cannot add a fake leave. */
export function usePlazaPosterTiming(key: string, dimensions: PlazaDimensions, startedAt?: number) {
  const state = useRef({ key, at: startedAt ?? performance.now(), done: false, owner: 0 });
  if (state.current.key !== key)
    state.current = { key, at: startedAt ?? performance.now(), done: false, owner: 0 };
  const current = state.current;
  const { route, media, sort } = dimensions;
  const finish = useCallback(
    (outcome: PlazaOutcome) => {
      if (current.done) return;
      current.done = true;
      reportPlazaMetric('poster', outcome, Math.max(0, performance.now() - current.at), {
        route,
        media,
        sort,
        measurement: 'image_decode_after_frame',
      });
    },
    [current, route, media, sort]
  );
  useEffect(() => {
    const owner = ++current.owner;
    const visibility = () => {
      if (document.hidden) finish('background');
    };
    visibility();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      queueMicrotask(() => {
        if (current.owner === owner) finish('left');
      });
    };
  }, [current, finish]);
  return finish;
}
