'use client';

import { GitBranch, Loader2 } from 'lucide-react';

export function ChatBranchButton({
  turnIndex,
  pending,
  disabled,
  onBranch,
}: {
  turnIndex: number;
  pending: boolean;
  disabled: boolean;
  onBranch: () => void;
}) {
  return (
    <button
      type="button"
      aria-label="分支到新聊天"
      title={`从第 ${turnIndex} 轮开启分支`}
      aria-busy={pending}
      disabled={disabled || pending}
      onClick={onBranch}
      className="inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-full px-2 text-[11px] text-muted-foreground/70 transition-colors hover:bg-secondary hover:text-foreground active:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <GitBranch className="size-4" aria-hidden />
      )}
      <span>分支到新聊天</span>
    </button>
  );
}
