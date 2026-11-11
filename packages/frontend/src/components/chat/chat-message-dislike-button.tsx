'use client';

import { useId } from 'react';
import { CHAT_FEEDBACK_REASONS, type ChatFeedbackReason, type ChatMessage } from '@miniapp/shared';
import { useReplyFeedback } from './use-reply-feedback';
import { Check, ThumbsDown, X } from 'lucide-react';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

export function ChatMessageDislikeButton({ message }: { message: ChatMessage }) {
  const detailId = useId();
  const {
    open,
    changeOpen,
    reasons,
    detail,
    changeDetail,
    toggleReason,
    submit,
    error,
    submitted,
    pending,
  } = useReplyFeedback(message);

  return (
    <Sheet open={open} onOpenChange={changeOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label={submitted ? '查看这条回复的反馈' : '不喜欢这条回复'}
          aria-pressed={submitted}
          className={cn(
            'inline-flex size-11 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-95',
            submitted ? 'text-primary' : 'text-muted-foreground/70 hover:text-foreground'
          )}
        >
          <ThumbsDown className={cn('size-4', submitted && 'fill-primary/20')} aria-hidden />
        </button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="mx-auto flex max-h-[85dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-[28px] border-white/10 bg-[#202022] px-5 pt-3 text-zinc-100 motion-reduce:animate-none motion-reduce:transition-none"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div aria-hidden className="mx-auto mb-3 h-1 w-9 shrink-0 rounded-full bg-white/15" />
        <div className="flex shrink-0 items-center justify-between gap-2">
          <SheetTitle className="text-lg font-semibold tracking-wide text-zinc-100">
            提交反馈
          </SheetTitle>
          <SheetClose
            aria-label="关闭反馈"
            className="-mr-2 flex size-11 shrink-0 items-center justify-center rounded-full text-zinc-400 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-[18px]" aria-hidden />
          </SheetClose>
        </div>
        <SheetDescription className="mb-3 shrink-0 text-[13px] leading-5 text-zinc-400">
          可以直接提交，也可以告诉我们原因。
        </SheetDescription>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="min-h-0 overflow-y-auto overscroll-contain">
            <FeedbackReasons reasons={reasons} toggleReason={toggleReason} disabled={pending} />
            <div className="mt-3 flex items-center justify-between">
              <label htmlFor={detailId} className="text-[13px] text-zinc-300">
                问题细节<span className="ml-1 text-xs text-zinc-500">（选填）</span>
              </label>
              <span className="text-[11px] tabular-nums text-zinc-500">{detail.length}/500</span>
            </div>
            <textarea
              id={detailId}
              data-sentry-mask
              maxLength={500}
              value={detail}
              disabled={pending}
              onChange={(event) => changeDetail(event.target.value)}
              placeholder="比如：前面说好的事，下一句就忘了…"
              className="mt-2 h-20 w-full resize-none rounded-xl border border-white/10 bg-black/10 p-3 text-base leading-6 text-zinc-200 outline-none placeholder:text-sm placeholder:text-zinc-600 focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
            />
          </div>
          <div className="shrink-0 pb-[max(16px,env(safe-area-inset-bottom))] pt-2">
            {error ? (
              <p role="alert" className="mb-2 text-xs leading-5 text-destructive">
                {error}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={pending}
              aria-busy={pending}
              className="flex min-h-12 w-full items-center justify-center rounded-xl bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:bg-white/[0.07] disabled:text-zinc-500"
            >
              {pending ? '提交中…' : '提交反馈'}
            </button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function FeedbackReasons({
  reasons,
  toggleReason,
  disabled,
}: {
  reasons: ChatFeedbackReason[];
  toggleReason: (reason: ChatFeedbackReason) => void;
  disabled: boolean;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend className="sr-only">反馈原因，可多选</legend>
      <div className="grid grid-cols-2 gap-2">
        {CHAT_FEEDBACK_REASONS.map((reason) => {
          const selected = reasons.includes(reason.id);
          return (
            <button
              type="button"
              key={reason.id}
              aria-pressed={selected}
              onClick={() => toggleReason(reason.id)}
              className={cn(
                'flex min-h-11 items-center justify-between gap-1 rounded-xl border px-3 py-2.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-white/[0.08] bg-white/[0.025] text-zinc-300 hover:bg-white/5'
              )}
            >
              {reason.label}
              <Check aria-hidden className={cn('size-3.5 shrink-0', !selected && 'invisible')} />
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
