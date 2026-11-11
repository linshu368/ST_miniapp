'use client';

import { useGuideInputBusy, useOnboarding } from '@/hooks/use-onboarding';
import type { ChatMessage } from '@miniapp/shared';
import { ChevronDown, ChevronRight, GitBranch, Pencil, X } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { useCreatorReturnVisit } from './creator-invitation';

const StoryGuideSheet = dynamic(
  () => import('./story-guide-sheet').then((module) => module.StoryGuideSheet),
  { ssr: false }
);

function lastCompleteReply(messages: readonly ChatMessage[]): ChatMessage | undefined {
  // No findLast dependency or whole-history copy on every streaming render.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      message?.role === 'assistant' &&
      message.turn_index > 0 &&
      !message.deleted &&
      message.status === 'complete'
    )
      return message;
  }
  return undefined;
}

export function ChatGuide({ messages, busy }: { messages: ChatMessage[]; busy: boolean }) {
  useCreatorReturnVisit();
  const { active, progress, update } = useOnboarding();
  const inputBusy = useGuideInputBusy();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [preferencesShown, setPreferencesShown] = useState(false);
  const reply = lastCompleteReply(messages);
  const replyId = reply?.id;
  useEffect(() => {
    if (!active) return;
    update({ started: true, ...(replyId ? { replied: true } : {}) });
  }, [active, replyId, update]);
  if ((!active || !progress || busy || inputBusy || (reply && progress.toolsSeen)) && !loaded)
    return null;
  const visible =
    active && progress && !busy && !inputBusy && (reply ? !progress.toolsSeen : !progress.replied);
  return (
    <>
      {visible ? (
        <aside
          aria-label="聊天上手提示"
          className="mx-6 mb-3 mt-1 rounded-2xl border border-primary/15 bg-primary/[0.04] min-[521px]:mx-auto min-[521px]:max-w-[620px]"
        >
          <div className="flex items-start gap-1 pl-3.5">
            <div className="min-w-0 flex-1 py-3">
              <p className="text-[13px] font-medium">
                {reply ? '聊偏了？你可以改' : '说一句话，或写下你想做的事'}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {reply ? '改一句话，或从中途重新聊。' : '没有固定答案，按你的想法继续就好。'}
              </p>
              {reply ? (
                <button
                  type="button"
                  onClick={() => {
                    setLoaded(true);
                    setOpen(true);
                  }}
                  className="-mb-1 mt-1 flex min-h-11 items-center gap-1.5 rounded-lg text-xs font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Pencil className="size-3.5" aria-hidden />
                  编辑<span className="px-1 text-muted-foreground/40">/</span>
                  <GitBranch className="size-3.5" aria-hidden />
                  分支
                  <ChevronRight className="ml-1 size-3.5" aria-hidden />
                </button>
              ) : !preferencesShown ? (
                <button
                  type="button"
                  onClick={() => {
                    const trigger = document.querySelector(
                      'section[aria-label="回复偏好"] button[aria-expanded]'
                    );
                    if (!(trigger instanceof HTMLButtonElement) || trigger.disabled) return;
                    if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
                    trigger.focus({ preventScroll: true });
                    setPreferencesShown(true);
                  }}
                  className="-mb-1 mt-1 flex min-h-11 items-center gap-1.5 rounded-lg text-xs font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  展开回复偏好
                  <ChevronDown className="size-3.5" aria-hidden />
                </button>
              ) : null}
            </div>
            <button
              type="button"
              aria-label={reply ? '收起特色提示' : '跳过新手引导'}
              onClick={() => update(reply ? { toolsSeen: true } : { skipped: true })}
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        </aside>
      ) : null}
      {loaded ? (
        <StoryGuideSheet
          open={open}
          messageId={reply?.id ?? null}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) update({ toolsSeen: true });
          }}
        />
      ) : null}
    </>
  );
}
