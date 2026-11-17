'use client';

import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useDramaScrub, type DramaScrubProps } from './use-drama-scrub';

type DramaProgressProps = DramaScrubProps;

function formatTime(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** 宽触区先预览、松手再定位，避免手指拖动持续触发媒体请求或误换剧。 */
export function DramaProgress(props: DramaProgressProps) {
  const { video, duration } = props;
  const latest = useRef(props);
  latest.current = props;
  const input = useRef<HTMLInputElement>(null);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const validDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const disabled = !video || !validDuration;
  const scrub = useDramaScrub(props, input, {
    disabled,
    validDuration,
    onStart: () => setKeyboardFocus(false),
  });
  const { preview, visibleTime } = scrub;
  const percent = validDuration ? (visibleTime / validDuration) * 100 : 0;

  const commitKeyboard = (seconds: number) => {
    if (!video || disabled || scrub.isScrubbing()) return;
    const value = Math.max(0, Math.min(validDuration, seconds));
    latest.current.onBeforeCommit?.(value, !video.paused);
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
          setKeyboardFocus(!scrub.isScrubbing() && event.currentTarget.matches(':focus-visible'))
        }
        onBlur={() => setKeyboardFocus(false)}
        {...scrub.handlers}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onChange={(event) => {
          // 指针松手已经提交过；这是同一次手势的原生回声，不能再提交一次。
          if (scrub.isPointerCommitEcho()) return;
          commitKeyboard(Number(event.target.value));
        }}
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
