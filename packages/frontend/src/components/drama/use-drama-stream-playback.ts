'use client';

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useDramaPlaybackQuery } from '@/lib/api/drama';
import { dramaTiming } from '@/lib/perf/drama-observer';
import type { DramaPlaybackTiming } from '@/lib/perf/drama-timing';

type TimingOwner = { videoId: string | null; retryVersion: number; flow: DramaPlaybackTiming };

/** Query and one fresh Stream request share the same intent, including synchronous duplicate media errors. */
export function useDramaStreamPlayback(
  id: string,
  activeVideoId: string | null,
  playbackOwner: DramaPlaybackTiming['owner'],
  retryVersion: number,
  timingRef: MutableRefObject<TimingOwner | null>
) {
  const sourceIntent = `${id}:${activeVideoId ?? ''}`;
  const [retry, setRetry] = useState<{ intent: string; videoId: string } | null>(null);
  const retrying = retry?.intent === sourceIntent;
  const retryAttempted = useRef<string | null>(null);
  useEffect(() => {
    retryAttempted.current = null;
    setRetry(null);
  }, [sourceIntent]);
  const playbackQuery = useDramaPlaybackQuery(
    id,
    retrying ? retry.videoId : (activeVideoId ?? undefined),
    retrying
  );
  const playback = playbackQuery.data;
  const recoverStream = useCallback(() => {
    if (
      retrying ||
      !playback?.video_id ||
      retryAttempted.current === sourceIntent ||
      playback.delivery?.group !== 'stream' ||
      (playback.delivery.provider !== 'stream' && playback.delivery.reason !== 'unavailable')
    )
      return false;
    retryAttempted.current = sourceIntent;
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
    // The first request may omit the episode; retry the exact video that failed.
    setRetry({ intent: sourceIntent, videoId: playback.video_id });
    return true;
  }, [
    retrying,
    playback?.video_id,
    sourceIntent,
    playback?.delivery,
    id,
    activeVideoId,
    playbackOwner,
    retryVersion,
    timingRef,
  ]);

  useEffect(() => {
    if (playback && !playback.playable) recoverStream();
  }, [playback, recoverStream]);

  return { playbackQuery, recoverStream };
}
