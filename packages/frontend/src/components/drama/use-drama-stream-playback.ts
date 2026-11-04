'use client';

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useDramaPlaybackQuery } from '@/lib/api/drama';
import { dramaTiming } from '@/lib/perf/drama-observer';
import type { DramaPlaybackTiming } from '@/lib/perf/drama-timing';

type TimingOwner = { videoId: string | null; retryVersion: number; flow: DramaPlaybackTiming };

/** Query and one fallback share the same intent, including synchronous duplicate media errors. */
export function useDramaStreamPlayback(
  id: string,
  activeVideoId: string | null,
  playbackOwner: DramaPlaybackTiming['owner'],
  retryVersion: number,
  timingRef: MutableRefObject<TimingOwner | null>
) {
  const sourceIntent = `${id}:${activeVideoId ?? ''}`;
  const [fallbackFor, setFallbackFor] = useState<string | null>(null);
  const fallbackAttempted = useRef<string | null>(null);
  useEffect(() => {
    fallbackAttempted.current = null;
    setFallbackFor(null);
  }, [sourceIntent]);
  const playbackQuery = useDramaPlaybackQuery(
    id,
    activeVideoId ?? undefined,
    fallbackFor === sourceIntent
  );
  const playback = playbackQuery.data;
  const recoverStream = useCallback(() => {
    if (
      fallbackFor === sourceIntent ||
      fallbackAttempted.current === sourceIntent ||
      playback?.delivery?.group !== 'stream' ||
      (playback.delivery.provider !== 'stream' && playback.delivery.reason !== 'unavailable')
    )
      return false;
    fallbackAttempted.current = sourceIntent;
    if (timingRef.current) {
      timingRef.current.flow.delivery = playback.delivery;
      timingRef.current.flow.finish('error');
    }
    const flow = dramaTiming.beginPlayback(
      id,
      'retry',
      activeVideoId ?? undefined,
      undefined,
      playbackOwner
    );
    flow.mark('player_ready');
    timingRef.current = { videoId: activeVideoId, retryVersion, flow };
    setFallbackFor(sourceIntent);
    return true;
  }, [
    fallbackFor,
    sourceIntent,
    playback?.delivery,
    id,
    activeVideoId,
    playbackOwner,
    retryVersion,
  ]);

  useEffect(() => {
    if (playback && !playback.playable) recoverStream();
  }, [playback, recoverStream]);

  return { playbackQuery, recoverStream };
}
