'use client';

import { useParams, useRouter } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
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
    <header className="fixed inset-x-0 top-0 z-20 box-border flex h-[calc(3.5rem+env(safe-area-inset-top))] items-end border-b border-border/60 bg-background/95 px-2 pb-2 pt-[env(safe-area-inset-top)] text-foreground shadow-[0_1px_12px_rgba(15,23,42,0.04)] backdrop-blur-xl">
      <div className="flex h-10 min-w-0 w-full items-center justify-between">
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => router.push('/')}
            className="flex size-10 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted active:scale-95"
            aria-label="返回大厅"
          >
            <ChevronLeft className="size-5" strokeWidth={2.2} />
          </button>
          <ChatSidebar />
        </div>

        <span className="pointer-events-none absolute left-1/2 max-w-[46%] -translate-x-1/2 truncate text-[16px] font-semibold tracking-tight text-foreground">
          {displayName}
        </span>

        <div className="flex shrink-0 items-center gap-1 pr-1">
          <FavoriteButton characterId={characterId} variant="header" />
        </div>
      </div>
    </header>
  );
}
