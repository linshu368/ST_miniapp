import { useMemo } from 'react';
import type { Message } from '@miniapp/shared';

import { formatMessageContent } from '@/lib/markdown';
import { CharacterAvatar } from '@/components/characters/character-avatar';
import { cn } from '@/lib/utils';

interface MessageBubbleProps {
  message: Message;
  charName?: string;
  userName?: string;
  charAvatarUrl?: string;
  characterId?: string;
  /** Cinematic Noir（聊天页专用） */
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
    return formatMessageContent({ text: message.content, charName, userName });
  }, [isUser, message.content, charName, userName]);

  const fontStyle = isNoir
    ? { fontSize: '12.5px', lineHeight: 1.7 as const }
    : { fontSize: 'calc(15px * var(--mes-font-scale, 1))' };

  if (!isUser) {
    return (
      <div
        className={cn(
          'flex w-full animate-whisper-in items-end',
          !isNoir && 'gap-2',
          isNoir && 'gap-0'
        )}
      >
        {!isNoir && (
          <CharacterAvatar
            avatarUrl={charAvatarUrl}
            name={charName}
            characterId={characterId}
            size="sm"
          />
        )}

        <div
          style={fontStyle}
          className={cn(
            'max-w-[82%] break-words',
            isNoir
              ? 'rounded-[14px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] px-3.5 py-3'
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
            ? 'rounded-[14px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] px-3.5 py-3 text-[#F2F3F5]'
            : 'rounded-2xl rounded-br-[6px] bg-secondary/55 px-4 py-2.5 leading-[1.5] text-foreground'
        )}
      >
        {message.content}
      </div>
    </div>
  );
}
