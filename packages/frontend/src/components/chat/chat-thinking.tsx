'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Atom, ChevronDown, Loader2 } from 'lucide-react';
import {
  thinkingDisclosureOpen,
  thinkingDisclosurePhase,
  type ThinkingDisclosurePhase,
} from '@/lib/chat-thinking';
import { PH_MASK_TEXT_CLASS, PH_NO_CAPTURE_CLASS } from '@/lib/telemetry/masking';
import { cn } from '@/lib/utils';

export function ChatThinkingToggle({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-label={enabled ? '关闭深度思考' : '开启深度思考'}
      aria-pressed={enabled}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      title={enabled ? '关闭深度思考' : '开启深度思考'}
      className={cn(
        'mr-1 inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-70 motion-reduce:transition-none',
        enabled
          ? 'border-primary/35 bg-primary/[0.09] text-primary shadow-[inset_0_1px_0_hsl(var(--primary)/0.08)]'
          : 'border-border/70 bg-transparent text-muted-foreground hover:bg-secondary/50'
      )}
    >
      <Atom className="size-[17px]" strokeWidth={1.8} aria-hidden />
      <span>深度思考</span>
    </button>
  );
}

/** Provider-exposed text only: separate from the role's answer and all reply actions. */
export function ChatThinking({
  text,
  streaming,
  content,
}: {
  text: string;
  streaming: boolean;
  content: string;
}) {
  const id = useId();
  const phase = thinkingDisclosurePhase(streaming, content);
  const [manual, setManual] = useState<{ phase: ThinkingDisclosurePhase; open: boolean } | null>(
    null
  );
  const open = thinkingDisclosureOpen(phase, manual);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  useEffect(() => {
    const node = scrollRef.current;
    if (open && node && followRef.current) node.scrollTop = node.scrollHeight;
  }, [open, text.length]);

  return (
    <section
      className={cn('relative mb-3', PH_MASK_TEXT_CLASS, PH_NO_CAPTURE_CLASS, 'sentry-mask')}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setManual({ phase, open: !open })}
        className="flex min-h-10 w-full items-center gap-2 rounded-lg text-left text-[12px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        {phase === 'thinking' ? (
          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
        ) : (
          <Atom className="size-4" strokeWidth={1.6} aria-hidden />
        )}
        <span
          className="font-medium tracking-[0.04em]"
          aria-live="polite"
          aria-label={phase === 'thinking' ? 'thinking，正在思考' : 'thinking，思考已结束'}
        >
          thinking
        </span>
        <ChevronDown
          className={cn(
            'size-3 transition-transform motion-reduce:transition-none',
            open && 'rotate-180'
          )}
          aria-hidden
        />
      </button>
      {open ? (
        <div
          id={id}
          ref={scrollRef}
          onScroll={(event) => {
            const node = event.currentTarget;
            followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
          }}
          tabIndex={0}
          aria-label="思考内容"
          className="chat-scroll-area max-h-40 overflow-y-auto overscroll-contain border-l-2 border-border/70 pl-3 pr-1 text-[12px] leading-[1.8] text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border"
        >
          <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{text}</p>
        </div>
      ) : null}
    </section>
  );
}
