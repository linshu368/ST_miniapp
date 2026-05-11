'use client';

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

import { cn } from '@/lib/utils';
import { GridMenu } from './grid-menu';

const schema = z.object({
  content: z.string().trim().min(1, '说点什么'),
});

type FormValues = z.infer<typeof schema>;

interface ComposerProps {
  onSend: (content: string) => void;
  disabled?: boolean;
  isAssistantTyping?: boolean;
  variant?: 'default' | 'noir';
  /** noir 模式下传给左侧菜单等；输入框占位保持空白 */
  charName?: string;
  /** noir 模式下替换左侧按钮的插槽，默认隐藏 */
  leftSlot?: ReactNode;
}

export function Composer({
  onSend,
  disabled,
  isAssistantTyping,
  variant = 'default',
  charName,
  leftSlot,
}: ComposerProps) {
  const isNoir = variant === 'noir';

  const noirPlaceholder = '';
  const defaultPlaceholder = '……';

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
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const canSend = isValid && !disabled;

  if (isNoir) {
    return (
      <form
        onSubmit={submit}
        className="flex w-full min-w-0 shrink-0 items-center gap-2 border-t border-white/8 bg-transparent px-4 py-3 pb-[calc(12px+env(safe-area-inset-bottom))]"
      >
        {leftSlot ?? <GridMenu charName={charName} />}

        <div className="flex min-h-[40px] min-w-0 flex-1 items-center rounded-2xl border border-white/10 bg-[#1e2330] px-3 py-2.5">
          <textarea
            {...contentProps}
            ref={(el) => {
              rhfRef(el);
              textareaRef.current = el;
            }}
            rows={1}
            onKeyDown={onKeyDown}
            placeholder={noirPlaceholder}
            className={cn(
              'min-h-[24px] flex-1 resize-none bg-transparent text-sm font-normal leading-normal',
              'text-white/90 placeholder:text-white/35',
              'focus:outline-none'
            )}
            aria-label="输入消息"
          />
          {isAssistantTyping && (
            <span
              className="mb-0.5 inline-block h-1.5 w-1.5 shrink-0 animate-breath rounded-full bg-[#8a9bb0]/55"
              aria-label="她正在打字"
            />
          )}
        </div>

        <button
          type="submit"
          disabled={!canSend}
          aria-label="发送"
          aria-disabled={!canSend}
          className={cn(
            'flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center bg-transparent p-2 transition-colors duration-200',
            canSend
              ? 'text-white hover:text-white/80 active:scale-[0.96]'
              : 'cursor-not-allowed text-[#8a9bb0]'
          )}
        >
          <SendIconFilled className="h-[22px] w-[22px] -rotate-[32deg]" />
        </button>
      </form>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="flex w-full min-w-0 shrink-0 items-end gap-2 bg-background/80 px-3 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-2 shadow-[0_-12px_32px_-20px_rgba(0,0,0,0.6)] backdrop-blur-md"
    >
      <div className="flex min-w-0 flex-1 items-end gap-1.5 rounded-[22px] bg-secondary/50 px-3 py-1.5 ring-1 ring-inset ring-border/40 transition-colors focus-within:ring-[hsl(var(--char-hue,var(--primary))_/_0.35)]">
        <textarea
          {...contentProps}
          ref={(el) => {
            rhfRef(el);
            textareaRef.current = el;
          }}
          rows={1}
          onKeyDown={onKeyDown}
          placeholder={defaultPlaceholder}
          className={cn(
            'flex-1 resize-none bg-transparent py-1.5 text-sm leading-relaxed',
            'text-foreground placeholder:text-muted-foreground/60',
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

function SendIconFilled({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn(className)} aria-hidden="true">
      <path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
    </svg>
  );
}

function SendIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      className={cn('h-5 w-5', className)}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12l14-7-5 14-3-6-6-1z" />
    </svg>
  );
}
