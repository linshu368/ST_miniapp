'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { platformAction } from '@/lib/bridge';
import { ModelTierSwitcher } from '@/components/tavern/model-tier-switcher';
import { ChatSidebar } from '@/components/tavern/chat-sidebar';

export default function TavernChatPage() {
  const { characterId } = useParams<{ characterId: string }>();

  useEffect(() => {
    if (!characterId) return;
    const avatar = `platform_${characterId}.png`;
    platformAction('selectCharacter', { avatar }).catch((err) => {
      console.error('[TavernChatPage] selectCharacter failed:', err);
    });
  }, [characterId]);

  return (
    <div className="relative w-full h-full">
      {/* Toolbar — floats on top of iframe */}
      <div className="absolute top-2 left-0 right-0 z-20 flex items-center justify-between px-3">
        <ChatSidebar />
        <ModelTierSwitcher />
      </div>
    </div>
  );
}
