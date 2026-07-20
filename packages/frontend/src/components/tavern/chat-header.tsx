'use client';

import { useParams, useRouter } from 'next/navigation';
import { Heart, Home, Library } from 'lucide-react';
import { ChatSidebar } from './chat-sidebar';
import { useCharacterQuery } from '@/lib/api/characters';
import { useFavoriteIdsQuery, useSetFavoriteMutation } from '@/lib/api/favorites';
import { useSTMirror } from '@/lib/bridge';
import { useChatListStore } from '@/stores/chat-list';
import { AppearanceToggle } from '@/components/appearance-toggle';

const AUTO_CHAT_NAME_RE = /\d{4}-\d{1,2}-\d{1,2}[@_]\d{1,2}h\d{1,2}m\d{1,2}s/;

export function ChatHeader() {
  const router = useRouter();
  const { characterId } = useParams<{ characterId: string }>();
  const { data } = useCharacterQuery(characterId);
  const currentChatId = useSTMirror((s) => s.currentChatId);
  const items = useChatListStore((s) => s.items);
  const favoriteIds = useFavoriteIdsQuery();
  const setFavorite = useSetFavoriteMutation();
  const favorited = favoriteIds.data?.character_ids.includes(characterId) ?? false;

  const activeChatItem = currentChatId
    ? items.find((item) => item.fileName === currentChatId)
    : null;
  const isRenamed = activeChatItem ? !AUTO_CHAT_NAME_RE.test(activeChatItem.fileName) : false;
  const displayName = isRenamed
    ? activeChatItem!.fileName
    : activeChatItem?.characterName || data?.character?.name || '';

  return (
    <div className="fixed left-0 right-0 top-0 z-20 flex h-12 items-center justify-between border-b border-border bg-background/95 px-3 pt-[env(safe-area-inset-top)] backdrop-blur-md">
      <div className="flex items-center">
        <ChatSidebar />
        <button
          type="button"
          onClick={() => router.push('/favorites')}
          className="rounded-full p-2 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="收藏角色"
        >
          <Library className="h-5 w-5" />
        </button>
        <AppearanceToggle className="size-9 shadow-none" />
      </div>
      <span className="pointer-events-none absolute left-1/2 max-w-[25%] -translate-x-1/2 truncate text-sm font-medium text-foreground">
        {displayName}
      </span>
      <div className="flex items-center">
        <button
          type="button"
          disabled={setFavorite.isPending}
          onClick={() => setFavorite.mutate({ characterId, favorited: !favorited })}
          className={`rounded-full p-2 transition-colors ${
            favorited ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
          }`}
          aria-label={favorited ? '取消收藏当前角色' : '收藏当前角色'}
          aria-pressed={favorited}
        >
          <Heart className={`h-5 w-5 ${favorited ? 'fill-current' : ''}`} />
        </button>
        <button
          onClick={() => router.push('/')}
          className="rounded-full p-2 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="返回大厅"
        >
          <Home className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
