'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { cn } from '@/lib/utils';

interface DramaProgressProps {
  video: HTMLVideoElement | null;
  time: number;
  duration: number;
  sourceKey: string;
  onScrubbingChange: (scrubbing: boolean) => void;
  onCommit: (seconds: number, wasPlaying: boolean) => void;
}

interface ScrubSession {
  pointerId: number;
  video: HTMLVideoElement;
  sourceKey: string;
  source: string;
  wasPlaying: boolean;
  value: number;
}

function formatTime(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** 宽触区先预览、松手再定位，避免手指拖动持续触发媒体请求或误换剧。 */
export function DramaProgress(props: DramaProgressProps) {
  const { video, time, duration, sourceKey } = props;
  const latest = useRef(props);
  latest.current = props;
  const input = useRef<HTMLInputElement>(null);
  const session = useRef<ScrubSession | null>(null);
  const pendingResume = useRef<ScrubSession | null>(null);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const validDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const disabled = !video || !validDuration;
  const visibleTime = Math.min(
    validDuration,
    Math.max(0, preview ?? (Number.isFinite(time) ? time : 0))
  );
  const percent = validDuration ? (visibleTime / validDuration) * 100 : 0;

  const cancelResume = useCallback(() => {
    const pending = pendingResume.current;
    pendingResume.current = null;
    if (
      pending &&
      latest.current.video === pending.video &&
      latest.current.sourceKey === pending.sourceKey &&
      (pending.video.currentSrc || pending.video.src) === pending.source
    ) {
      pending.video.pause();
    }
  }, []);

  const finish = useCallback((commit: boolean, resume: boolean) => {
    const current = session.current;
    if (!current) return;
    session.current = null;
    const sameMedia =
      latest.current.video === current.video &&
      latest.current.sourceKey === current.sourceKey &&
      (current.video.currentSrc || current.video.src) === current.source;
    if (commit && sameMedia) {
      current.video.currentTime = current.value;
      latest.current.onCommit(current.value, current.wasPlaying);
    }
    setPreview(null);
    latest.current.onScrubbingChange(false);
    if (input.current?.hasPointerCapture(current.pointerId)) {
      input.current.releasePointerCapture(current.pointerId);
    }
    // 原来暂停的内容仍暂停；换源、离页和卸载都不能被迟到的恢复动作抢播。
    if (resume && sameMedia && current.wasPlaying && document.visibilityState !== 'hidden') {
      pendingResume.current = current;
      void current.video
        .play()
        .then(() => {
          if (pendingResume.current === current) pendingResume.current = null;
        })
        .catch(() => {
          if (pendingResume.current === current) pendingResume.current = null;
          // 浏览器拒绝播放时保留已定位画面，由原播放器的播放入口继续。
        });
    }
  }, []);

  useEffect(() => {
    const cancelOnHide = () => {
      if (document.visibilityState === 'hidden') {
        cancelResume();
        finish(false, false);
      }
    };
    const cancelSecondPointer = (event: globalThis.PointerEvent) => {
      if (session.current && event.pointerId !== session.current.pointerId) finish(false, true);
    };
    const cancelOnBlur = () => {
      cancelResume();
      finish(false, false);
    };
    document.addEventListener('visibilitychange', cancelOnHide);
    document.addEventListener('pointerdown', cancelSecondPointer, true);
    window.addEventListener('blur', cancelOnBlur);
    return () => {
      cancelResume();
      finish(false, false);
      document.removeEventListener('visibilitychange', cancelOnHide);
      document.removeEventListener('pointerdown', cancelSecondPointer, true);
      window.removeEventListener('blur', cancelOnBlur);
    };
  }, [finish, cancelResume, video, sourceKey]);

  const position = (clientX: number) => {
    const box = input.current?.getBoundingClientRect();
    if (!box?.width) return visibleTime;
    return Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * validDuration;
  };
  const start = (event: PointerEvent<HTMLInputElement>) => {
    if (disabled || !video || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setKeyboardFocus(false);
    pendingResume.current = null;
    const value = position(event.clientX);
    session.current = {
      pointerId: event.pointerId,
      video,
      sourceKey,
      source: video.currentSrc || video.src,
      wasPlaying: !video.paused && !video.ended,
      value,
    };
    latest.current.onScrubbingChange(true);
    video.pause();
    setPreview(value);
    event.currentTarget.focus({ preventScroll: true });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 宿主已取消触点时恢复原状态，不能留下一根无人能松开的进度条。
      finish(false, true);
    }
  };

  const commitKeyboard = (seconds: number) => {
    if (!video || disabled || session.current) return;
    const value = Math.max(0, Math.min(validDuration, seconds));
    video.currentTime = value;
    latest.current.onCommit(value, !video.paused);
  };

  return (
    <div
      data-drama-progress
      data-player-no-swipe
      data-progress-scrubbing={preview !== null}
      className={cn(
        'relative flex h-12 w-full shrink-0 touch-none items-center',
        disabled && 'opacity-30'
      )}
    >
      <input
        ref={input}
        type="range"
        aria-label="播放进度"
        aria-valuetext={`${formatTime(visibleTime)} / ${formatTime(validDuration)}`}
        min={0}
        max={validDuration}
        step={0.1}
        value={visibleTime}
        disabled={disabled}
        onFocus={(event) =>
          setKeyboardFocus(!session.current && event.currentTarget.matches(':focus-visible'))
        }
        onBlur={() => setKeyboardFocus(false)}
        onPointerDown={start}
        onPointerMove={(event) => {
          const current = session.current;
          if (!current || current.pointerId !== event.pointerId) return;
          event.preventDefault();
          event.stopPropagation();
          current.value = position(event.clientX);
          setPreview(current.value);
        }}
        onPointerUp={(event) => {
          if (session.current?.pointerId !== event.pointerId) return;
          event.preventDefault();
          event.stopPropagation();
          session.current.value = position(event.clientX);
          finish(true, true);
        }}
        onPointerCancel={(event) => {
          if (session.current?.pointerId === event.pointerId) finish(false, true);
        }}
        onLostPointerCapture={(event) => {
          if (
            session.current?.pointerId === event.pointerId &&
            !event.currentTarget.hasPointerCapture(event.pointerId)
          ) {
            finish(false, true);
          }
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onChange={(event) => commitKeyboard(Number(event.target.value))}
        onKeyDown={(event) => {
          setKeyboardFocus(true);
          const next = {
            ArrowLeft: visibleTime - 5,
            ArrowDown: visibleTime - 5,
            ArrowRight: visibleTime + 5,
            ArrowUp: visibleTime + 5,
            Home: 0,
            End: validDuration,
          }[event.key];
          if (next === undefined) return;
          event.preventDefault();
          event.stopPropagation();
          commitKeyboard(next);
        }}
        className="peer absolute inset-0 z-20 m-0 h-full w-full touch-none cursor-pointer opacity-0 disabled:cursor-default"
      />
      <div
        aria-hidden
        className={cn(
          'pointer-events-none relative w-full rounded-full bg-white/25 transition-[height] duration-100 motion-reduce:transition-none',
          preview !== null ? 'h-1.5' : 'h-[3px]',
          keyboardFocus && 'ring-2 ring-white/60 ring-offset-4 ring-offset-black'
        )}
      >
        <div className="h-full rounded-full bg-[#eee7e2]" style={{ width: `${percent}%` }} />
        <div
          className={cn(
            'absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#eee7e2] shadow-sm transition-[width,height] duration-100 motion-reduce:transition-none',
            preview !== null ? 'h-4 w-4' : 'h-2 w-2'
          )}
          style={{ left: `${percent}%` }}
        />
      </div>
      {preview !== null ? (
        <output
          aria-label="拖动目标时间"
          className="pointer-events-none absolute -top-12 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-xl border border-white/10 bg-[#211f22]/95 px-4 py-2 text-lg font-semibold tabular-nums text-[#eee7e2] shadow-lg"
        >
          {formatTime(preview)}{' '}
          <span className="text-sm font-normal text-[#eee7e2]/45">
            / {formatTime(validDuration)}
          </span>
        </output>
      ) : null}
    </div>
  );
}
