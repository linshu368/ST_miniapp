import { useMemo } from 'react';
import type { Message } from '@miniapp/shared';

import { formatMessageContent, formatMessageContentNoirAssistant } from '@/lib/markdown';
import { CharacterAvatar } from '@/components/characters/character-avatar';
import { cn } from '@/lib/utils';

interface MessageBubbleProps {
  message: Message;
  charName?: string;
  userName?: string;
  charAvatarUrl?: string;
  characterId?: string;
  variant?: 'default' | 'noir';
}

export function MessageBubble({
  message,
  charName,
  userName,
  charAvatarUrl,
  characterId,
  variant = 'default',
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isNoir = variant === 'noir';

  const renderedHtml = useMemo(() => {
    if (isUser) return '';
    if (isNoir) {
      return formatMessageContentNoirAssistant({
        text: message.content,
        charName,
        userName,
      });
    }
    return formatMessageContent({ text: message.content, charName, userName });
  }, [isUser, isNoir, message.content, charName, userName]);

  const fontStyle = !isNoir ? { fontSize: 'calc(15px * var(--mes-font-scale, 1))' } : undefined;

  if (!isUser) {
    return (
      <div className="flex w-full animate-whisper-in items-end gap-2">
        <CharacterAvatar
          avatarUrl={charAvatarUrl}
          name={charName}
          characterId={characterId}
          size="sm"
        />

        <div
          style={fontStyle}
          className={cn(
            'max-w-[82%] break-words',
            isNoir
              ? 'rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3'
              : 'rounded-2xl rounded-bl-[6px] bg-secondary/50 px-4 py-2.5 leading-[1.5] text-foreground/90'
          )}
        >
          <div className="mes-text" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full animate-whisper-in justify-end">
      <div
        style={fontStyle}
        className={cn(
          'max-w-[82%] whitespace-pre-wrap break-words',
          isNoir
            ? 'rounded-[18px] rounded-br-[4px] bg-white/10 px-[14px] py-[12px] text-[14px] font-normal leading-relaxed text-white/82'
            : 'rounded-2xl rounded-br-[6px] bg-secondary/55 px-4 py-2.5 leading-[1.5] text-foreground'
        )}
      >
        {message.content}
      </div>
    </div>
  );
}
