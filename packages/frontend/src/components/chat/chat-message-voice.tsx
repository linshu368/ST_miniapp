'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Loader2, Pencil, Volume2 } from 'lucide-react';
import type { MessageVoice } from '@miniapp/shared';
import { formatMediaAttemptBillingLabel } from '@/components/chat/media-billing-label';
import { VoiceBar } from './chat-voice-bar';

export interface MessageVoiceState {
  /** 该消息已有的语音记录；从未生成过时为 undefined */
  voice: MessageVoice | undefined;
  playbackRate: number;
  /** 生成请求在途。与 voice.status === 'pending' 一起构成「生成中」 */
  submitting: boolean;
  onGenerate: () => void;
  /** 「自定义本次语音」页的地址；会话还没落库时为 null，此时入口不出现 */
  customHref: string | null;
  /** 已发布的语音免费体验上限，用于格式化本次 attempt 快照。 */
  freeTrialLimit: number | null;
  /** 失败提示文案，按 error_code 选用（来自 voice config hints） */
  hints: {
    overLimit: string;
    draftFailed: string;
    ttsFailed: string;
  };
}

/**
 * 角色回复底部的一行。
 *
 * 语音就绪后要换到第二行：语音条最宽 300px，窄屏上和字数、回复操作挤在
 * 同一行必然溢出，而 PRD 要求语音条不超过消息内容区域。未就绪时只是个小按钮，
 * 挨着字数放得下，也就不占额外高度。
 */
export function ChatMessageVoiceFooter({
  charCount,
  voice,
  regenerate,
  toolsAction,
  editAction,
  likeAction,
}: {
  charCount: number;
  /** null = 这条消息不支持语音（开场白、未写完的回复），此时只显示重生成 */
  voice: MessageVoiceState | null;
  regenerate: ReactNode;
  toolsAction?: ReactNode;
  editAction?: ReactNode;
  likeAction?: ReactNode;
}) {
  if (!voice) {
    return regenerate || toolsAction || editAction || likeAction ? (
      <div className="flex items-end gap-x-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-1">
          <span className="text-[11px] text-muted-foreground/70">{charCount} 字</span>
          {toolsAction}
        </div>
        {editAction || regenerate || likeAction ? (
          <div className="ml-auto flex shrink-0 items-center gap-0 [&>button]:w-9 [&>button]:rounded-md [&>button]:bg-transparent [&>button:hover]:bg-transparent [&>button:active]:bg-transparent">
            {editAction}
            {regenerate}
            {likeAction}
          </div>
        ) : null}
      </div>
    ) : null;
  }

  const current = voice.voice;
  const audioUrl = current?.status === 'ready' ? current.audio_url : null;
  // 失败码：status=failed 用 error_code（首次失败，无上一版可播）；
  // status=ready 但本次重生成失败时用 last_error_code（旧音频仍可播，提示挂在播放条下方）。
  const failureCode = current?.status === 'failed' ? current.error_code : current?.last_error_code;
  // 超限红字：仅当失败码为 voice_text_too_long 时展示。
  // 成功、或用户再次点下去变 pending 时（failureCode 变 null）自动隐藏。
  const overLimit = failureCode === 'voice_text_too_long' ? voice.hints.overLimit : null;
  // 其它失败小字：写稿失败 / TTS 失败，与超限那句区分。
  const otherFailedHint =
    failureCode && failureCode !== 'voice_text_too_long'
      ? isTtsFailure(failureCode)
        ? voice.hints.ttsFailed
        : voice.hints.draftFailed
      : null;
  const attemptPriceLabel = current
    ? formatMediaAttemptBillingLabel(current, voice.freeTrialLimit)
    : null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-end gap-x-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-1">
          <span className="text-[11px] text-muted-foreground/70">{charCount} 字</span>
          {audioUrl ? null : <VoiceAction {...voice} />}
          {toolsAction}
        </div>
        {editAction || regenerate || likeAction ? (
          <div className="ml-auto flex shrink-0 items-center gap-0 [&>button]:w-9 [&>button]:rounded-md [&>button]:bg-transparent [&>button:hover]:bg-transparent [&>button:active]:bg-transparent">
            {editAction}
            {regenerate}
            {likeAction}
          </div>
        ) : null}
      </div>
      {overLimit ? (
        <p className="text-[11px] leading-snug text-destructive">{overLimit}</p>
      ) : otherFailedHint ? (
        <p className="text-[11px] leading-snug text-muted-foreground/80">{otherFailedHint}</p>
      ) : null}
      {audioUrl ? (
        <>
          <VoiceBar
            key={audioUrl}
            src={audioUrl}
            durationMs={current?.duration_ms ?? null}
            playbackRate={voice.playbackRate}
            onRegenerate={voice.onGenerate}
          />
          {attemptPriceLabel ? (
            <p className="text-[10px] leading-snug text-muted-foreground">{attemptPriceLabel}</p>
          ) : null}
          <SpokenTextPanel text={current?.spoken_text ?? ''} customHref={voice.customHref} />
        </>
      ) : null}
    </div>
  );
}

/** TTS 失败码以 voice_tts_ 前缀；写稿失败以 voice_draft_ 前缀。 */
function isTtsFailure(code: string | null | undefined): boolean {
  return typeof code === 'string' && code.startsWith('voice_tts');
}

/**
 * 「本次语音文字」：这段声音实际念了什么。
 *
 * 默认展开，不做折叠。它存在的理由是台词和上方的回复正文本来就不一样——正文含
 * 叙述、动作、心理描写，台词只留说出口的话。要点一下才看得到，用户根本不会知道
 * 有这个差异，也就永远解释不了「听到的和看到的不一样」。
 *
 * 语音就绪才渲染（由调用方保证）：没有成品时摆一个空文字框，会让人以为已经有能播的东西了。
 */
function SpokenTextPanel({ text, customHref }: { text: string; customHref: string | null }) {
  // 就绪的记录理应都带台词，但兜一手：宁可说明白「没记录」，也别渲染一个空白框
  const hasText = text.trim().length > 0;

  return (
    <div className="w-full max-w-[300px] space-y-1.5 rounded-xl border border-border bg-card/60 px-2.5 py-2">
      <p className="text-[10px] font-medium text-muted-foreground/70">本次语音文字</p>
      {hasText ? (
        <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground/90">
          {text}
        </p>
      ) : (
        <p className="text-[12px] text-muted-foreground/70">这条语音生成时还没有记录文字</p>
      )}
      {customHref ? (
        <Link
          href={customHref}
          className="flex items-center gap-1 pt-0.5 text-[11px] font-medium text-primary transition-opacity hover:opacity-80"
        >
          <Pencil className="size-3" aria-hidden />
          自定义本次语音
        </Link>
      ) : null}
    </div>
  );
}

function VoiceAction({ voice, submitting, onGenerate }: MessageVoiceState) {
  const generating = submitting || voice?.status === 'pending';

  if (generating) {
    return (
      <span
        role="status"
        title="语音生成中"
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground/70"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden />
        <span className="sr-only">语音生成中</span>
      </span>
    );
  }

  // ready 态由 ChatMessageVoiceFooter 直接渲染语音条，走不到这里
  const isRetry = voice?.status === 'failed';
  const label = isRetry ? '重试语音' : '生成语音';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onGenerate}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-secondary hover:text-foreground active:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Volume2 className="size-4" strokeWidth={1.7} aria-hidden />
    </button>
  );
}
