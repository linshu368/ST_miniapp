'use client';

import { LoaderCircle } from 'lucide-react';

export function StudioGenerateButton({
  pending,
  disabled,
  quoteText,
  onClick,
}: {
  pending: boolean;
  disabled: boolean;
  quoteText: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="发送生成"
      aria-describedby="image-generation-quote"
      className="ml-auto inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-full bg-primary px-2.5 text-sm font-semibold text-primary-foreground shadow-[0_5px_16px_hsl(var(--primary)/0.15)] transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-40 min-[360px]:px-3"
    >
      {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
      <span className="whitespace-nowrap">{pending ? '提交中' : '生成'}</span>
      <span
        id="image-generation-quote"
        className="whitespace-nowrap text-xs font-medium tabular-nums opacity-75"
      >
        {quoteText}
      </span>
    </button>
  );
}
