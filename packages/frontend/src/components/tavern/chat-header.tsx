'use client';

import { useParams, useRouter } from 'next/navigation';
import { Home } from 'lucide-react';
import { ChatSidebar } from './chat-sidebar';
import { useCharacterQuery } from '@/lib/api/characters';

export function ChatHeader() {
  const router = useRouter();
  const { characterId } = useParams<{ characterId: string }>();
  const { data } = useCharacterQuery(characterId);

  return (
    <div className="fixed top-0 left-0 right-0 z-20 flex items-center justify-between px-3 h-12 bg-[#1a1a2e]/95 backdrop-blur-md pt-[env(safe-area-inset-top)]">
      <ChatSidebar />
      <span className="absolute left-1/2 -translate-x-1/2 text-sm font-medium text-white truncate max-w-[55%] pointer-events-none">
        {data?.character?.name ?? ''}
      </span>
      <button
        onClick={() => router.push('/')}
        className="rounded-full p-2 text-white/70 hover:text-white transition-colors"
        aria-label="返回大厅"
      >
        <Home className="h-5 w-5" />
      </button>
    </div>
  );
}
