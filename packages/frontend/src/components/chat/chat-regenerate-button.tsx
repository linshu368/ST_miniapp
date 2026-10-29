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
  label = '换一个回复',
}: {
  onRegenerate: () => void;
  pending: boolean;
  disabled: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-busy={pending}
      onClick={onRegenerate}
      disabled={disabled || pending}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-secondary hover:text-foreground active:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <RefreshCw className="size-4" aria-hidden />
      )}
    </button>
  );
}
