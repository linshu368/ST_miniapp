import type { Message } from '@miniapp/shared';

import { cn } from '@/lib/utils';

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <div className={cn('flex w-full animate-whisper-in', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[82%] whitespace-pre-wrap break-words text-[16px] leading-[1.75]',
          isUser
            ? 'rounded-[20px] rounded-br-[6px] bg-secondary/70 px-4 py-2.5 text-foreground'
            : 'px-1 text-foreground/85'
        )}
      >
        {message.content}
      </div>
    </div>
  );
}
