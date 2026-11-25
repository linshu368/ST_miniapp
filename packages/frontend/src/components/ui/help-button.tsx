'use client';

import { CircleQuestionMark } from 'lucide-react';

import { cn } from '@/lib/utils';

/** 小问号：说明默认收起，点开才看。说明由使用处就地展开，不用浮层，抽屉里不会被裁掉。 */
export function HelpButton({
  label,
  open,
  onToggle,
  className,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={`${label}说明`}
      aria-expanded={open}
      onClick={onToggle}
      className={cn(
        'relative -my-2 grid size-7 shrink-0 place-items-center rounded-full transition-colors before:absolute before:-inset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        open ? 'text-foreground' : 'text-muted-foreground/70',
        className
      )}
    >
      <CircleQuestionMark className="size-[14px]" aria-hidden />
    </button>
  );
}
