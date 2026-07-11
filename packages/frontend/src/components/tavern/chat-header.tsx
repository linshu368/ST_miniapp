'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Home } from 'lucide-react';
import { ChatSidebar } from './chat-sidebar';
import { ChatToolsMenu } from './chat-tools-menu';
import { CHAT_SCROLL_EVENT } from '@/components/bridge/st-iframe';
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
  const [scrollProgress, setScrollProgress] = useState(0);

  useEffect(() => {
    const handleChatScroll = (event: Event) => {
      const detail = (event as CustomEvent<{ progress?: number }>).detail;
      setScrollProgress(Math.min(1, Math.max(0, detail?.progress ?? 0)));
    };
    window.addEventListener(CHAT_SCROLL_EVENT, handleChatScroll);
    return () => window.removeEventListener(CHAT_SCROLL_EVENT, handleChatScroll);
  }, []);

  const activeChatItem = currentChatId
    ? items.find((item) => item.fileName === currentChatId)
    : null;
  const isRenamed = activeChatItem ? !AUTO_CHAT_NAME_RE.test(activeChatItem.fileName) : false;
  const displayName = isRenamed
    ? activeChatItem!.fileName
    : activeChatItem?.characterName || data?.character?.name || '';

  return (
    <header
      className={`fixed inset-x-0 top-0 z-20 grid h-[calc(3.25rem+env(safe-area-inset-top))] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 px-2 pb-1 pt-[env(safe-area-inset-top)] text-white will-change-transform sm:px-3 ${
        scrollProgress >= 0.96 ? 'pointer-events-none' : ''
      }`}
      style={{
        opacity: 1 - scrollProgress,
        transform: `translate3d(0, ${-18 * scrollProgress}px, 0)`,
        background: 'transparent',
      }}
    >
      <div className="flex h-10 items-center bg-transparent px-0.5">
        <ChatSidebar />
        <ChatToolsMenu />
      </div>
      <span className="pointer-events-none min-w-0 truncate px-2 text-center text-[clamp(0.75rem,3.5vw,0.9rem)] font-medium text-white/90 drop-shadow-[0_2px_8px_rgba(0,0,0,0.85)]">
        {displayName}
      </span>
      <button
        onClick={() => router.push('/')}
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-transparent text-white transition-colors hover:bg-white/10 hover:text-white active:scale-95"
        aria-label="返回大厅"
      >
        <Home className="h-5 w-5" />
      </button>
    </header>
  );
}
