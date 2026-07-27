'use client';

import { useParams, useRouter } from 'next/navigation';
import { Home } from 'lucide-react';
import { ChatSidebar } from './chat-sidebar';
import { FavoriteButton } from '@/components/characters/favorite-button';
import { useCharacterQuery } from '@/lib/api/characters';
import { useSTMirror } from '@/lib/bridge';
import { useChatListStore } from '@/stores/chat-list';

const AUTO_CHAT_NAME_RE = /\d{4}-\d{1,2}-\d{1,2}[@_]\d{1,2}h\d{1,2}m\d{1,2}s/;

export function ChatHeader() {
  const router = useRouter();
  const { characterId } = useParams<{ characterId: string }>();
  const { data } = useCharacterQuery(characterId);
  const currentChatId = useSTMirror((s) => s.currentChatId);
  const items = useChatListStore((s) => s.items);

  const activeChatItem = currentChatId
    ? items.find((item) => item.fileName === currentChatId)
    : null;
  const isRenamed = activeChatItem ? !AUTO_CHAT_NAME_RE.test(activeChatItem.fileName) : false;
  const displayName = isRenamed
    ? activeChatItem!.fileName
    : activeChatItem?.characterName || data?.character?.name || '';

  return (
    <div className="fixed top-0 left-0 right-0 z-20 flex items-center justify-between px-3 h-12 bg-[#1a1a2e]/95 backdrop-blur-md pt-[env(safe-area-inset-top)]">
      <ChatSidebar />
      {/* 右侧多了收藏按钮，标题可用宽度相应收窄，避免长角色名压到按钮。 */}
      <span className="absolute left-1/2 -translate-x-1/2 text-sm font-medium text-white truncate max-w-[45%] pointer-events-none">
        {displayName}
      </span>
      <div className="flex items-center gap-0.5">
        <FavoriteButton characterId={characterId} variant="header" />
        <button
          onClick={() => router.push('/')}
          className="rounded-full p-2 text-white/70 hover:text-white transition-colors"
          aria-label="返回大厅"
        >
          <Home className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
