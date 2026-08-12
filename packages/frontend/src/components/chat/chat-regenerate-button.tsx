'use client';

import { Loader2, RefreshCw } from 'lucide-react';

/**
 * 重生成。只挂在最后一轮的 assistant 气泡下：后端只允许对最后一轮重生成，
 * 挂在别处点了必然拿到 409 regenerate_not_allowed。
 */
export function ChatRegenerateButton({
  onRegenerate,
  pending,
  disabled,
}: {
  onRegenerate: () => void;
  pending: boolean;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onRegenerate}
      disabled={disabled || pending}
      className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-45"
    >
      {pending ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        <RefreshCw className="h-3.5 w-3.5" aria-hidden />
      )}
      换一个回复
    </button>
  );
}
