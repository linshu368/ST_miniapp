'use client';

import type { ComponentType } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';

/**
 * 工具箱里的一行入口。抽出来是因为一级页和各个设置分组都要用它——
 * 留在 chat-tools-sheet 里会让设置组件反过来 import 抽屉，绕成一个环。
 */
export function ToolRow({
  icon: Icon,
  title,
  hint,
  onClick,
  pending,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  hint: string;
  onClick: () => void;
  pending?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="flex w-full items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3.5 text-left transition-colors hover:bg-secondary disabled:opacity-55"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="size-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-semibold text-foreground">{title}</span>
        <span className="mt-0.5 block truncate text-[11px] leading-snug text-muted-foreground">
          {hint}
        </span>
      </span>
      {pending ? (
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
      ) : (
        <ChevronRight className="size-4 shrink-0 text-muted-foreground/70" aria-hidden />
      )}
    </button>
  );
}
