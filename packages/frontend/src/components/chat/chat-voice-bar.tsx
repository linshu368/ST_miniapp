'use client';

import { useEffect, useRef, useState } from 'react';
import { Pause, Play, RefreshCw } from 'lucide-react';
import { createVoicePlayback } from './voice-playback';
import { voicePlaybackHint, type VoicePlaybackFailure } from './voice-playback-report';

interface VoiceBarProps {
  src: string;
  durationMs: number | null;
  playbackRate: number;
  onRegenerate: () => void;
  regenerateDisabled?: boolean;
}

function useVoicePlayback(playbackRate: number) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const controller = useRef<ReturnType<typeof createVoicePlayback> | null>(null);
  const [playing, setPlaying] = useState(false);
  const [failure, setFailure] = useState<VoicePlaybackFailure | null>(null);
  useEffect(() => {
    const player = audioRef.current;
    if (!player) return;
    const playback = createVoicePlayback(player, { playing: setPlaying, failure: setFailure });
    controller.current = playback;
    return () => {
      controller.current = null;
      playback.dispose();
    };
  }, []);
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = playbackRate;
  }, [playbackRate]);
  return { audioRef, playing, failure, toggle: () => controller.current?.toggle(playbackRate) };
}

/** Same compact controls; only a failed playback adds a short inline hint. */
export function VoiceBar({
  src,
  durationMs,
  playbackRate,
  onRegenerate,
  regenerateDisabled = false,
}: VoiceBarProps) {
  const { audioRef, playing, failure, toggle } = useVoicePlayback(playbackRate);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(durationMs ? durationMs / 1000 : 0);
  const seekable = duration > 0;
  return (
    <div className="w-full max-w-[300px] space-y-1">
      <div className="flex w-full items-center gap-2 rounded-full border border-border bg-card px-2 py-1.5">
        <audio
          ref={audioRef}
          src={src}
          preload="metadata"
          onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
          onLoadedMetadata={(event) => {
            const loaded = event.currentTarget.duration;
            if (Number.isFinite(loaded) && loaded > 0) setDuration(loaded);
          }}
          onEnded={(event) => {
            setPosition(0);
            event.currentTarget.currentTime = 0;
          }}
        />
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? '暂停' : '播放'}
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary transition-colors hover:bg-primary/20"
        >
          {playing ? (
            <Pause className="size-3 fill-current" aria-hidden />
          ) : (
            <Play className="size-3 fill-current" aria-hidden />
          )}
        </button>
        <input
          type="range"
          min={0}
          max={seekable ? duration : 1}
          step={0.1}
          value={position}
          disabled={!seekable}
          aria-label="播放进度"
          onChange={(event) => {
            const next = Number(event.target.value);
            setPosition(next);
            if (audioRef.current) audioRef.current.currentTime = next;
          }}
          className="voice-progress h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-border disabled:cursor-default"
          style={{
            backgroundImage: `linear-gradient(to right, hsl(var(--primary)) ${seekable ? (position / duration) * 100 : 0}%, transparent 0%)`,
          }}
        />
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {formatClock(position > 0 ? position : duration)}
        </span>
        <button
          type="button"
          onClick={onRegenerate}
          disabled={regenerateDisabled}
          aria-label="重新生成语音"
          className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
        >
          <RefreshCw className="size-3" aria-hidden />
        </button>
      </div>
      {failure ? (
        <p role="status" className="text-[11px] leading-snug text-muted-foreground">
          {voicePlaybackHint(failure)}
        </p>
      ) : null}
    </div>
  );
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
