import { Clock3 } from 'lucide-react';

import type { FreeZoneSwitchDivider } from '@/lib/free-zone';

/**
 * 对话里「免费模型 → 付费模型」那一轮前的分隔线（对比稿 B）：留在聊天记录里，
 * 回头翻也能看出从哪一轮开始扣星尘。
 */
export function ChatFreeZoneDivider({ divider }: { divider: FreeZoneSwitchDivider }) {
  return (
    <div role="note" className="my-1.5 flex flex-col items-center gap-1.5 px-2">
      {divider.title ? (
        <div className="flex w-full items-center gap-2.5">
          <span
            aria-hidden
            className="h-px flex-1 bg-[linear-gradient(90deg,transparent,hsl(var(--free-zone)/0.4))]"
          />
          <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-free-zone">
            <Clock3 className="size-3" aria-hidden />
            {divider.title}
          </span>
          <span
            aria-hidden
            className="h-px flex-1 bg-[linear-gradient(90deg,hsl(var(--free-zone)/0.4),transparent)]"
          />
        </div>
      ) : null}
      <span className="flex w-full items-center gap-2.5 text-center text-[11.5px] leading-snug text-muted-foreground">
        {divider.title ? null : <span aria-hidden className="h-px flex-1 bg-border" />}
        <span className={divider.title ? 'w-full' : 'shrink-0'}>{divider.detail}</span>
        {divider.title ? null : <span aria-hidden className="h-px flex-1 bg-border" />}
      </span>
    </div>
  );
}
