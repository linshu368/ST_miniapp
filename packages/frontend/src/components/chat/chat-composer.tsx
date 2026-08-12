'use client';

import { useEffect, useRef } from 'react';
import { Loader2, SendHorizontal, Square } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** 与后端 routes/conversations.ts 的 MAX_USER_INPUT_LENGTH 对齐，前端先拦一道 */
export const MAX_USER_INPUT_LENGTH = 8000;

/** 快到上限时才提示，平时不打扰 */
const COUNTER_REVEAL_AT = MAX_USER_INPUT_LENGTH - 500;

interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** 有一轮正在生成 */
  generating: boolean;
  /** 会话还没就绪等原因导致不能发 */
  disabled: boolean;
}

export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  generating,
  disabled,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 输入框跟着内容长高，但不超过 8 行——再高就把消息区挤没了
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }, [value]);

  const overLimit = value.length > MAX_USER_INPUT_LENGTH;
  const canSend = value.trim().length > 0 && !overLimit && !generating && !disabled;

  return (
    <div className="sticky bottom-0 border-t border-border bg-background/90 px-3 py-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] backdrop-blur-xl">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) return;
            event.preventDefault();
            if (canSend) onSend();
          }}
          rows={1}
          disabled={disabled}
          placeholder={generating ? '对方正在回复…' : '说点什么…'}
          aria-label="输入消息"
          className={cn(
            'max-h-40 min-h-[42px] flex-1 resize-none rounded-[20px] border bg-card px-4 py-2.5 text-[15px] text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60',
            overLimit ? 'border-destructive' : 'border-border'
          )}
        />

        {/* 生成中把发送换成停止：这时候唯一有意义的操作就是叫停 */}
        {generating ? (
          <Button
            type="button"
            size="icon"
            variant="secondary"
            onClick={onStop}
            aria-label="停止生成"
            className="h-[42px] w-[42px] shrink-0 rounded-full"
          >
            <Square className="h-4 w-4 fill-current" aria-hidden />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon"
            onClick={onSend}
            disabled={!canSend}
            aria-label="发送"
            className="h-[42px] w-[42px] shrink-0 rounded-full"
          >
            {disabled ? (
              <Loader2 className="h-[18px] w-[18px] animate-spin" aria-hidden />
            ) : (
              <SendHorizontal className="h-[18px] w-[18px]" aria-hidden />
            )}
          </Button>
        )}
      </div>

      {value.length >= COUNTER_REVEAL_AT ? (
        <p
          className={cn(
            'mt-1.5 pr-1 text-right text-[11px]',
            overLimit ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {value.length} / {MAX_USER_INPUT_LENGTH}
        </p>
      ) : null}
    </div>
  );
}
