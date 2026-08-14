'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { shouldExpandComposer } from './composer-layout';

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
  /** 胶囊左端的工具位，原版这里是唤起工具箱的按钮 */
  leftSlot?: ReactNode;
}

export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  generating,
  disabled,
  leftSlot,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(false);

  // 输入框跟着内容长高，上限半屏——再高就把消息区挤没了。
  // 先把高度放开再量，量到的才是真实内容高度，否则读回来的是上一次设进去的值。
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    const contentHeight = node.scrollHeight;
    setExpanded((current) => shouldExpandComposer(value, contentHeight, current));
    node.style.height = `${Math.min(contentHeight, window.innerHeight * 0.5)}px`;
  }, [value]);

  // 单行与两栏两套版式的内边距不同，切换的那一帧要按新版式重新量一次高度
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, window.innerHeight * 0.5)}px`;
  }, [expanded]);

  const overLimit = value.length > MAX_USER_INPUT_LENGTH;
  const canSend = value.trim().length > 0 && !overLimit && !generating && !disabled;

  /**
   * 发完就收键盘。iOS 上不主动 blur 的话键盘会一直杵着，把刚发出去的那条
   * 连同角色的回复一起压在屏幕外，用户得先手动点一下空白才能看到回复。
   */
  const send = () => {
    if (!canSend) return;
    textareaRef.current?.blur();
    onSend();
  };

  return (
    <div className="bg-background px-2.5 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-2">
      <div
        className={cn(
          'relative min-h-[50px] rounded-[22px] border bg-card shadow-[0_8px_28px_rgb(16_13_15/40%)] transition-colors',
          'focus-within:outline focus-within:outline-2 focus-within:outline-primary/[0.12]',
          expanded
            ? 'grid grid-cols-[48px_minmax(0,1fr)_48px] grid-rows-[auto_48px] items-center'
            : 'flex items-center',
          overLimit
            ? 'border-destructive'
            : 'border-border focus-within:border-[color-mix(in_srgb,hsl(var(--primary))_55%,hsl(var(--border)))]'
        )}
      >
        <div
          className={cn(
            'flex shrink-0 items-center justify-center',
            expanded ? 'col-start-1 row-start-2 w-12 self-center' : 'w-[46px]'
          )}
        >
          {leftSlot}
        </div>

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) return;
            event.preventDefault();
            send();
          }}
          rows={1}
          disabled={disabled}
          placeholder={generating ? '对方正在回复…' : '说点什么…'}
          aria-label="输入消息"
          className={cn(
            'resize-none overflow-y-auto bg-transparent text-[15px] leading-[22px] text-foreground caret-primary',
            'placeholder:text-muted-foreground focus-visible:outline-none disabled:opacity-60',
            'chat-scroll-area',
            expanded
              ? 'col-span-3 row-start-1 min-h-[42px] w-full px-3.5 pb-1 pt-3'
              : 'min-h-[48px] flex-1 pb-2.5 pl-1 pr-1.5 pt-[13px]'
          )}
        />

        <div
          className={cn(
            'flex size-12 shrink-0 items-center justify-center',
            expanded && 'col-start-3 row-start-2 self-center'
          )}
        >
          {/* 生成中把发送换成停止：这时候唯一有意义的操作就是叫停 */}
          {generating ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="停止生成"
              className="flex size-10 items-center justify-center rounded-full bg-secondary text-primary shadow-[inset_0_0_0_1px_hsl(var(--border))]"
            >
              <span className="size-[15px] rounded-[4px] bg-current" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              aria-label="发送"
              className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_5px_14px_hsl(var(--primary)/0.28)] transition-opacity disabled:opacity-45 disabled:shadow-none"
            >
              {disabled ? (
                <Loader2 className="size-5 animate-spin" aria-hidden />
              ) : (
                <SendArrowIcon />
              )}
            </button>
          )}
        </div>
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

/** 原版发送键的箭头，与 lucide 的 send 图形不同，按原路径还原 */
function SendArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden>
      <path d="M12 3.5 5.25 10.25l1.5 1.5L11 7.5V20h2V7.5l4.25 4.25 1.5-1.5L12 3.5Z" />
    </svg>
  );
}
