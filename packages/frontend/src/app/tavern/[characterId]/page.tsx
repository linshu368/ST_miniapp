'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Home } from 'lucide-react';
import { platformAction, useBridgeStatus } from '@/lib/bridge';
import { ModelTierSwitcher } from '@/components/tavern/model-tier-switcher';
import { ChatSidebar } from '@/components/tavern/chat-sidebar';

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
      {/* Toolbar — floats on top of iframe */}
      <div className="absolute top-2 left-0 right-0 z-20 flex items-center justify-between px-3">
        <div className="flex items-center gap-2">
          <ChatSidebar />
          <Link
            href="/"
            aria-label="返回大厅"
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-black/40 px-3 text-xs font-medium text-white/80 backdrop-blur-sm transition-colors hover:text-white"
          >
            <Home className="h-4 w-4" aria-hidden />
            <span>大厅</span>
          </Link>
        </div>
        <ModelTierSwitcher />
      </div>
    </div>
  );
}
