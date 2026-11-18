'use client';
import type { VideoPlazaPlayback, VideoPlazaPlaybackObservation } from '@miniapp/shared';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { loadHlsMediaSource } from '@/lib/hls-media-source';
import {
  useVideoPlazaObservationMutation,
  useVideoPlazaPlaybackMutation,
} from '@/lib/api/video-plaza';

function usePlazaVideoSource(artifactId: string, playback: VideoPlazaPlayback, active: boolean) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [fresh, setFresh] = useState<VideoPlazaPlayback | null>(null);
  const [failed, setFailed] = useState(false);
  const refreshCount = useRef(0);
  const alive = useRef(true);
  const { mutateAsync: refreshPlayback } = useVideoPlazaPlaybackMutation(artifactId);
  const position = useRef({ seconds: 0, playing: false });
  const recover = useCallback(async () => {
    if (!alive.current) return;
    const node = videoRef.current;
    if (!node || refreshCount.current >= 1) {
      setFailed(true);
      return;
    }
    refreshCount.current++;
    position.current = { seconds: node.currentTime, playing: !node.paused };
    try {
      const result = await refreshPlayback();
      if (alive.current) {
        setFresh(result.playback);
        setFailed(false);
      }
    } catch {
      if (alive.current) setFailed(true);
    }
  }, [refreshPlayback]);
  const target = fresh ?? playback;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const node = videoRef.current;
    if (!node || !active) return;
    let disposed = false;
    const restore = () => {
      if (disposed) return;
      if (position.current.seconds > 0) node.currentTime = position.current.seconds;
      if (position.current.playing) void node.play().catch(() => undefined);
    };
    const stop = loadHlsMediaSource(
      node,
      target,
      () => {
        if (node.readyState >= 1) restore();
        else node.addEventListener('loadedmetadata', restore, { once: true });
      },
      () => {
        if (!disposed) void recover();
      },
      undefined,
      {
        startPosition: position.current.seconds || undefined,
        // Modern Apple MMS retains the full ABR ladder; old Apple engines keep native HLS.
        forceHlsOnApple: 'ManagedMediaSource' in window,
      }
    );
    const hidden = () => {
      if (document.visibilityState === 'hidden') node.pause();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      disposed = true;
      stop();
      document.removeEventListener('visibilitychange', hidden);
      node.removeEventListener('loadedmetadata', restore);
      node.pause();
      node.removeAttribute('src');
      node.load();
    };
  }, [active, target, recover]);
  return { videoRef, failed, recover };
}

function usePlazaVideoObservation(
  videoRef: RefObject<HTMLVideoElement>,
  artifactId: string,
  failed: boolean
) {
  const { mutate: send } = useVideoPlazaObservationMutation();
  const timing = useRef({
    started: 0,
    firstSettled: false,
    seeking: 0,
    waiting: 0,
    stalls: 0,
    stallMs: 0,
    reports: 0,
  });
  const alive = useRef(true);
  const report = useCallback(
    (
      stage: VideoPlazaPlaybackObservation['stage'],
      outcome: VideoPlazaPlaybackObservation['outcome'],
      duration: number,
      count?: number
    ) => {
      if (timing.current.reports++ >= 8) return;
      send({
        artifact_id: artifactId,
        stage,
        outcome,
        duration_ms: Math.min(3_600_000, Math.max(0, duration)),
        ...(count !== undefined ? { count } : {}),
      });
    },
    [artifactId, send]
  );
  const frame = (run: () => void) => {
    const node = videoRef.current;
    const shown = () => {
      if (alive.current) run();
    };
    if (node?.requestVideoFrameCallback) node.requestVideoFrameCallback(shown);
    else
      requestAnimationFrame(() => {
        if (node && node.readyState >= 2) shown();
      });
  };
  useEffect(() => {
    alive.current = true;
    const current = timing.current;
    return () => {
      alive.current = false;
      if (current.started && !current.firstSettled)
        report('first_frame', 'interrupted', performance.now() - current.started);
      if (current.waiting) current.stallMs += performance.now() - current.waiting;
      if (current.stalls) report('stall', 'succeeded', current.stallMs, current.stalls);
      if (current.seeking) report('seek', 'interrupted', performance.now() - current.seeking);
    };
  }, [report]);
  useEffect(() => {
    if (failed && timing.current.started && !timing.current.firstSettled) {
      timing.current.firstSettled = true;
      report('first_frame', 'failed', performance.now() - timing.current.started);
    }
  }, [failed, report]);
  return {
    onPlay: () => {
      if (!timing.current.started) timing.current.started = performance.now();
    },
    onPlaying: () => {
      const current = timing.current;
      if (current.waiting) {
        current.stallMs += performance.now() - current.waiting;
        current.waiting = 0;
      }
      if (current.started && !current.firstSettled)
        frame(() => {
          if (current.firstSettled) return;
          current.firstSettled = true;
          report('first_frame', 'succeeded', performance.now() - current.started);
        });
    },
    onSeeking: () => {
      if (!timing.current.seeking) timing.current.seeking = performance.now();
    },
    onSeeked: () => {
      const started = timing.current.seeking;
      if (started)
        frame(() => {
          if (timing.current.seeking !== started) return;
          report('seek', 'succeeded', performance.now() - started);
          timing.current.seeking = 0;
        });
    },
    onWaiting: () => {
      if (timing.current.firstSettled && !timing.current.waiting) {
        timing.current.waiting = performance.now();
        timing.current.stalls++;
      }
    },
  };
}

/** Artifact identity owns the player lifecycle; both consumers key this component by artifactId. */
export function PlazaVideoPlayer({
  artifactId,
  playback,
  poster,
  active = true,
  onReady,
}: {
  artifactId: string;
  playback: VideoPlazaPlayback;
  poster?: string;
  active?: boolean;
  onReady?: () => void;
}) {
  const source = usePlazaVideoSource(artifactId, playback, active);
  const observation = usePlazaVideoObservation(source.videoRef, artifactId, source.failed);
  return (
    <>
      <video
        ref={source.videoRef}
        poster={poster}
        controls={active}
        playsInline
        preload={active ? 'metadata' : 'none'}
        className="absolute inset-0 size-full object-contain"
        onLoadedData={onReady}
        onError={() => void source.recover()}
        {...observation}
      />
      {source.failed ? (
        <p
          role="status"
          className="absolute bottom-12 inset-x-3 rounded-lg bg-black/70 p-2 text-center text-xs text-white"
        >
          视频暂时无法播放，请重新打开后重试
        </p>
      ) : null}
    </>
  );
}
