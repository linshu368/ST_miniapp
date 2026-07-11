'use client';

import { useParams, useRouter } from 'next/navigation';
import { Home } from 'lucide-react';
import { ChatSidebar } from './chat-sidebar';
import { ChatToolsMenu } from './chat-tools-menu';
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
    <header className="fixed inset-x-0 top-0 z-20 grid h-[calc(3rem+env(safe-area-inset-top))] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 border-b border-white/[0.08] bg-[#171525]/92 px-2 pt-[env(safe-area-inset-top)] text-white shadow-[0_8px_24px_rgba(0,0,0,0.2)] backdrop-blur-xl sm:px-3">
      <div className="flex h-12 items-center">
        <ChatSidebar />
        <ChatToolsMenu />
      </div>
      <span className="min-w-0 truncate px-2 text-center text-[clamp(0.75rem,3.5vw,0.9rem)] font-medium text-white/90 pointer-events-none">
        {displayName}
      </span>
      <button
        onClick={() => router.push('/')}
        className="flex size-10 shrink-0 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white active:scale-95"
        aria-label="返回大厅"
      >
        <Home className="h-5 w-5" />
      </button>
    </header>
  );
}
