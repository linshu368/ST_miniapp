'use client';

import { useRef } from 'react';
import { GitBranch, MoreHorizontal, Pencil, X } from 'lucide-react';
import { CHAT_MESSAGE_EDIT_ROUNDS } from '@miniapp/shared';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';

export type StoryGuideAction = 'edit' | 'branch';

export function StoryGuideContent({ onTry }: { onTry?: (action: StoryGuideAction) => void }) {
  return (
    <div className="mt-5 space-y-3">
      <section className="rounded-2xl border border-primary/15 bg-primary/[0.045] p-4">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Pencil className="size-4 text-primary" aria-hidden />
          编辑
        </h3>
        <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
          改改你或角色的话，接着按你的想法聊。
        </p>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          最近 {CHAT_MESSAGE_EDIT_ROUNDS} 轮可改，后面的回复不变。
        </p>
        {onTry ? (
          <button
            type="button"
            onClick={() => onTry('edit')}
            className="-mb-1 mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary/10 text-[13px] font-medium text-primary"
          >
            <Pencil className="size-3.5" aria-hidden />
            试试编辑
          </button>
        ) : null}
      </section>
      <section className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <GitBranch className="size-4 text-primary" aria-hidden />
          分支
        </h3>
        <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
          从这一轮重新聊，原对话留着。
        </p>
        {onTry ? (
          <button
            type="button"
            onClick={() => onTry('branch')}
            className="-mb-1 mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-white/5 text-[13px] font-medium text-foreground"
          >
            <MoreHorizontal className="size-4" aria-hidden />
            看看分支入口
          </button>
        ) : null}
      </section>
      <p className="px-1 text-xs leading-5 text-muted-foreground">
        自己的话点「···」编辑，分支也在回复的「···」里。
      </p>
    </div>
  );
}

export function StoryGuideSheet({
  open,
  onOpenChange,
  messageId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messageId: string | null;
}) {
  const pending = useRef<StoryGuideAction | null>(null);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[86dvh] max-w-lg overflow-y-auto overscroll-contain rounded-t-[28px] px-5 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3 motion-reduce:animate-none"
        onCloseAutoFocus={(event) => {
          if (!pending.current || !messageId) return;
          const action = pending.current;
          pending.current = null;
          event.preventDefault();
          // Open the real, existing control only on explicit intent; never save or fork here.
          const message = document.getElementById(`chat-message-${messageId}`);
          const target = message?.querySelector(
            action === 'edit' ? 'button[title="编辑正文"]' : 'button[aria-label$="操作"]'
          );
          if (target instanceof HTMLButtonElement && !target.disabled) {
            target.scrollIntoView({ block: 'nearest', behavior: 'auto' });
            target.focus({ preventScroll: true });
            target.click();
          }
        }}
      >
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-white/15" aria-hidden />
        <div className="flex items-start justify-between gap-2">
          <div className="pt-1">
            <SheetTitle className="text-lg font-semibold">聊偏了？你可以改</SheetTitle>
            <SheetDescription className="mt-1.5 text-xs">
              改一句话，或从中途重新聊。
            </SheetDescription>
          </div>
          <button
            type="button"
            aria-label="关闭玩法说明"
            onClick={() => onOpenChange(false)}
            className="-mr-2 -mt-1 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <StoryGuideContent
          onTry={
            messageId
              ? (action) => {
                  pending.current = action;
                  onOpenChange(false);
                }
              : undefined
          }
        />
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="mt-4 min-h-11 w-full rounded-full bg-primary text-sm font-medium text-primary-foreground"
        >
          知道了，继续聊
        </button>
      </SheetContent>
    </Sheet>
  );
}
