'use client';

import { useEffect, useRef } from 'react';
import type { Message } from '@miniapp/shared';

import { MessageBubble } from './message-bubble';
import { TypingIndicator } from './typing-indicator';

interface MessageListProps {
  messages: Message[];
  isTyping: boolean;
  charName?: string;
  userName?: string;
  charAvatarUrl?: string;
  characterId?: string;
  variant?: 'default' | 'noir';
}

export function MessageList({
  messages,
  isTyping,
  charName,
  userName,
  charAvatarUrl,
  characterId,
  variant = 'default',
}: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, isTyping]);

  return (
    <div className="flex flex-col space-y-6 px-6 py-4">
      {messages.map((m) => (
        <MessageBubble
          key={m.id}
          message={m}
          charName={charName}
          userName={userName}
          charAvatarUrl={charAvatarUrl}
          characterId={characterId}
          variant={variant}
        />
      ))}
      {isTyping && (
        <TypingIndicator
          charAvatarUrl={charAvatarUrl}
          characterId={characterId}
          variant={variant}
        />
      )}
      <div ref={endRef} />
    </div>
  );
}
