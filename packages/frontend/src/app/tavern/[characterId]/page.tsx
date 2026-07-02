'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { platformAction, useBridgeStatus } from '@/lib/bridge';
import { ChatHeader } from '@/components/tavern/chat-header';
import { ChatToolsMenu } from '@/components/tavern/chat-tools-menu';

export default function TavernChatPage() {
  const { characterId } = useParams<{ characterId: string }>();
  const bridgeStatus = useBridgeStatus();

  useEffect(() => {
    if (!characterId || bridgeStatus !== 'ready') return;
    const avatar = `platform_${characterId}.png`;
    platformAction('selectCharacter', { avatar }).catch((err) => {
      console.error('[TavernChatPage] selectCharacter failed:', err);
    });
  }, [bridgeStatus, characterId]);

  return (
    <div className="relative w-full h-full">
      <ChatHeader />
      <ChatToolsMenu />
    </div>
  );
}
