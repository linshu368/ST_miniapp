'use client';

import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import type { ChatMessage } from '@miniapp/shared';

import { cn } from '@/lib/utils';
import { ChatMarkdown } from './chat-markdown';

interface ChatMessageBubbleProps {
  message: ChatMessage;
  /** 正在流式写入这条消息。此时用 message.content 承载已收到的增量 */
  streaming?: boolean;
  /** 挂在气泡下方的操作区，目前只有重生成按钮 */
  footer?: ReactNode;
}

export function ChatMessageBubble({ message, streaming, footer }: ChatMessageBubbleProps) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-[18px] rounded-br-md bg-primary px-3.5 py-2.5 text-[15px] leading-relaxed text-primary-foreground">
          {message.content}
        </div>
      </div>
    );
  }

  // 生成被打断时后端会把已写入的部分连同 interrupted 一起落库。
  // 这半截正文是有价值的（用户已经读过了），只在末尾标注，不把气泡换成错误态。
  const interrupted = message.status === 'interrupted';
  const failed = message.status === 'failed';

  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="max-w-[88%] rounded-[18px] rounded-bl-md border border-border bg-card px-3.5 py-2.5 text-foreground">
        {failed && !message.content ? (
          <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
            这条回复没能生成
          </p>
        ) : (
          <>
            <ChatMarkdown content={message.content} />
            {streaming ? (
              <span
                className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] animate-pulse bg-primary align-middle"
                aria-hidden
              />
            ) : null}
            {interrupted ? (
              <p className="mt-2 flex items-center gap-1.5 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
                <AlertCircle className="h-3 w-3 shrink-0" aria-hidden />
                这条回复被中断了
              </p>
            ) : null}
          </>
        )}
      </div>
      {footer ? <div className="pl-1">{footer}</div> : null}
    </div>
  );
}

/** 首帧还没到、只有占位气泡时的呼吸点 */
export function ChatTypingBubble() {
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          'flex items-center gap-1 rounded-[18px] rounded-bl-md border border-border bg-card px-4 py-3.5'
        )}
      >
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="size-1.5 rounded-full bg-primary/70"
            style={{ animation: `splash-dot 1.3s ease-in-out ${index * 0.18}s infinite` }}
          />
        ))}
      </div>
    </div>
  );
}
