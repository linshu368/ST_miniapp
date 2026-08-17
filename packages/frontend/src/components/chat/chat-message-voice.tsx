'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AudioLines, Loader2, Pause, Play, RefreshCw } from 'lucide-react';
import type { MessageVoice } from '@miniapp/shared';

/**
 * 同一时刻只让一段语音在响。
 *
 * 每条消息各有一个 <audio>，不管住就会出现两个角色同时说话——用户点了第二条
 * 并不表示他想混着听第一条。放在模块级而不是 context：这里只需要「上一个是谁」，
 * 引一层 provider 反而要求页面配合。
 */
let activePlayer: HTMLAudioElement | null = null;

function claimPlayback(next: HTMLAudioElement): void {
  if (activePlayer && activePlayer !== next) activePlayer.pause();
  activePlayer = next;
}

export interface MessageVoiceState {
  /** 该消息已有的语音记录；从未生成过时为 undefined */
  voice: MessageVoice | undefined;
  playbackRate: number;
  /** 生成请求在途。与 voice.status === 'pending' 一起构成「生成中」 */
  submitting: boolean;
  onGenerate: () => void;
}

/**
 * 角色回复底部的一行。
 *
 * 语音就绪后要换到第二行：语音条最宽 300px，窄屏上和字数、「换一个回复」挤在
 * 同一行必然溢出，而 PRD 要求语音条不超过消息内容区域。未就绪时只是个小按钮，
 * 挨着字数放得下，也就不占额外高度。
 */
export function ChatMessageVoiceFooter({
  charCount,
  voice,
  regenerate,
}: {
  charCount: number;
  /** null = 这条消息不支持语音（开场白、未写完的回复），此时只显示重生成 */
  voice: MessageVoiceState | null;
  regenerate: ReactNode;
}) {
  if (!voice) {
    return regenerate ? <>{regenerate}</> : null;
  }

  const current = voice.voice;
  const audioUrl = current?.status === 'ready' ? current.audio_url : null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <span className="text-[11px] text-muted-foreground/70">{charCount} 字</span>
        {audioUrl ? null : <VoiceAction {...voice} />}
        {regenerate}
      </div>
      {audioUrl ? (
        <VoiceBar
          src={audioUrl}
          durationMs={current?.duration_ms ?? null}
          playbackRate={voice.playbackRate}
          onRegenerate={voice.onGenerate}
        />
      ) : null}
    </div>
  );
}

function VoiceAction({ voice, submitting, onGenerate }: MessageVoiceState) {
  const generating = submitting || voice?.status === 'pending';

  if (generating) {
    return (
      <span className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        生成中
      </span>
    );
  }

  // ready 态由 ChatMessageVoiceFooter 直接渲染语音条，走不到这里
  return (
    <button
      type="button"
      onClick={onGenerate}
      className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
    >
      <AudioLines className="h-3.5 w-3.5" aria-hidden />
      {voice?.status === 'failed' ? '重试语音' : '生成语音'}
    </button>
  );
}

/**
 * 紧凑语音条：播放/暂停 + 进度 + 时长 + 重新生成，单行。
 * 宽度跟着消息内容列走并留上限，移动端不会顶到屏幕边。
 */
function VoiceBar({
  src,
  durationMs,
  playbackRate,
  onRegenerate,
}: {
  src: string;
  durationMs: number | null;
  playbackRate: number;
  onRegenerate: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  // 上游给的时长优先；拿不到时等 loadedmetadata 补上，在此之前进度条不可拖
  const [duration, setDuration] = useState(durationMs ? durationMs / 1000 : 0);

  // 倍速改了要对正在播的这条立即生效，这是「播放速度」区别于「合成语速」的地方
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  // 卸载时让出播放权，否则切会话后音频还在响，而且 activePlayer 会指向死节点
  useEffect(
    () => () => {
      const player = audioRef.current;
      if (!player) return;
      player.pause();
      if (activePlayer === player) activePlayer = null;
    },
    []
  );

  const toggle = useCallback(() => {
    const player = audioRef.current;
    if (!player) return;

    if (player.paused) {
      claimPlayback(player);
      player.playbackRate = playbackRate;
      void player.play().catch(() => setPlaying(false));
    } else {
      player.pause();
    }
  }, [playbackRate]);

  const seekable = duration > 0;

  return (
    <div className="flex w-full max-w-[300px] items-center gap-2 rounded-full border border-border bg-card px-2 py-1.5">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => {
          const loaded = event.currentTarget.duration;
          if (Number.isFinite(loaded) && loaded > 0) setDuration(loaded);
        }}
        onEnded={(event) => {
          setPlaying(false);
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
          // 原生 range 无法只给已播部分上色，用背景渐变模拟
          backgroundImage: `linear-gradient(to right, hsl(var(--primary)) ${
            seekable ? (position / duration) * 100 : 0
          }%, transparent 0%)`,
        }}
      />

      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
        {formatClock(position > 0 ? position : duration)}
      </span>

      <button
        type="button"
        onClick={onRegenerate}
        aria-label="重新生成语音"
        className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-secondary hover:text-foreground"
      >
        <RefreshCw className="size-3" aria-hidden />
      </button>
    </div>
  );
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
