'use client';

import { useParams, useRouter } from 'next/navigation';
import { Bookmark, ChevronLeft, Heart } from 'lucide-react';
import { ChatSidebar } from './chat-sidebar';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useCharacterQuery } from '@/lib/api/characters';
import { useFavoriteIdsQuery, useSetFavoriteMutation } from '@/lib/api/favorites';
import { useSTMirror } from '@/lib/bridge';
import { useChatListStore } from '@/stores/chat-list';

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
  const characterName = data?.character?.name || displayName;

  return (
    <header className="fixed inset-x-0 top-0 z-20 box-border flex h-[calc(3.5rem+env(safe-area-inset-top))] items-end border-b border-border/60 bg-background/95 px-2 pb-2 pt-[env(safe-area-inset-top)] text-foreground shadow-[0_1px_12px_rgba(15,23,42,0.04)] backdrop-blur-xl">
      <div className="flex h-10 w-full items-center justify-between">
        <div className="flex items-center gap-0.5">
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

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => router.push('/favorites')}
            className="flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-95"
            aria-label="收藏角色列表"
          >
            <Bookmark className="size-[19px]" strokeWidth={2} />
          </button>
          <button
            type="button"
            disabled={setFavorite.isPending}
            onClick={() => setFavorite.mutate({ characterId, favorited: !favorited })}
            className={`relative flex size-10 items-center justify-center rounded-full border bg-card p-0.5 shadow-sm transition active:scale-95 ${
              favorited ? 'border-primary ring-2 ring-primary/20' : 'border-border'
            }`}
            aria-label={favorited ? '取消收藏当前角色' : '收藏当前角色'}
            aria-pressed={favorited}
          >
            <Avatar className="size-full">
              <AvatarImage
                src={data?.character?.avatar_url}
                alt={characterName}
                className="object-cover object-top"
              />
              <AvatarFallback className="text-xs font-semibold text-muted-foreground">
                {characterName.slice(0, 1)}
              </AvatarFallback>
            </Avatar>
            <span
              className={`absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full border-2 border-background ${
                favorited ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              }`}
            >
              <Heart className={`size-2.5 ${favorited ? 'fill-current' : ''}`} />
            </span>
          </button>
        </div>
      </div>
    </header>
  );
}
