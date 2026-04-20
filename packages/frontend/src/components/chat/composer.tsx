'use client';

import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

import { cn } from '@/lib/utils';

// 送出的消息只要非空即可（trim 后），不做更多校验——克制
const schema = z.object({
  content: z.string().trim().min(1, '说点什么'),
});

type FormValues = z.infer<typeof schema>;

interface ComposerProps {
  onSend: (content: string) => void;
  disabled?: boolean;
  /** 她正在打字时，输入框给一个轻微气息提示 */
  isAssistantTyping?: boolean;
}

export function Composer({ onSend, disabled, isAssistantTyping }: ComposerProps) {
  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { isValid },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { content: '' },
    mode: 'onChange',
  });

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { ref: rhfRef, ...contentProps } = register('content');

  // 自适应高度：最大 5 行左右
  const content = watch('content');
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [content]);

  const submit = handleSubmit((values) => {
    onSend(values.content.trim());
    reset({ content: '' });
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  });

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const canSend = isValid && !disabled;

  return (
    <form
      onSubmit={submit}
      className="flex items-end gap-2 bg-background/80 px-3 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-2 shadow-[0_-12px_32px_-20px_rgba(0,0,0,0.6)] backdrop-blur-md"
    >
      <div className="flex flex-1 items-end gap-1.5 rounded-[22px] bg-secondary/50 px-3 py-1.5 ring-1 ring-inset ring-border/40 transition-colors focus-within:ring-[hsl(var(--char-hue,var(--primary))_/_0.35)]">
        <textarea
          {...contentProps}
          ref={(el) => {
            rhfRef(el);
            textareaRef.current = el;
          }}
          rows={1}
          onKeyDown={onKeyDown}
          placeholder="……"
          className={cn(
            'flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-relaxed',
            'text-foreground placeholder:text-muted-foreground/50',
            'focus:outline-none'
          )}
          aria-label="输入消息"
        />

        {isAssistantTyping && (
          <span
            className="mb-2 inline-block h-1.5 w-1.5 shrink-0 animate-breath rounded-full bg-[hsl(var(--char-hue,12)_70%_65%)]"
            aria-label="她正在打字"
          />
        )}
      </div>

      <button
        type="submit"
        disabled={!canSend}
        aria-label="发送"
        className={cn(
          'grid h-10 w-10 shrink-0 place-items-center rounded-full transition-all duration-200',
          canSend
            ? 'text-primary-foreground active:scale-95'
            : 'bg-muted text-muted-foreground/40 opacity-60'
        )}
        style={
          canSend
            ? {
                background: `hsl(var(--char-hue, 12) 75% 62%)`,
                boxShadow: `0 0 22px -4px hsl(var(--char-hue, 12) 75% 62% / 0.7)`,
              }
            : undefined
        }
      >
        <SendIcon />
      </button>
    </form>
  );
}

function SendIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12l14-7-5 14-3-6-6-1z" />
    </svg>
  );
}
