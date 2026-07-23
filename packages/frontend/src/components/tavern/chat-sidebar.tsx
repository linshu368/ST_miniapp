'use client';

import { useEffect, useState, useCallback } from 'react';
import { Ellipsis, Trash2, Pencil, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Sheet, SheetTrigger, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { platformAction, useBridgeStatus, useSTEvent, useSTMirror } from '@/lib/bridge';
import { useChatListStore } from '@/stores/chat-list';
import { useSTMirrorStore } from '@/stores/st-mirror';

const AUTO_CHAT_NAME_RE = /\d{4}-\d{1,2}-\d{1,2}[@_]\d{1,2}h\d{1,2}m\d{1,2}s/;

export function ChatSidebar() {
  const [open, setOpen] = useState(false);
  const bridgeStatus = useBridgeStatus();
  const currentChatId = useSTMirror((s) => s.currentChatId);
  const { items, loading, fetch, invalidate } = useChatListStore();

  const bridgeReady = bridgeStatus === 'ready';

  useEffect(() => {
    if (open) fetch();
  }, [open, fetch]);

  useSTEvent(
    'chat:created',
    useCallback(() => invalidate(), [invalidate])
  );
  useSTEvent(
    'chat:deleted',
    useCallback(() => invalidate(), [invalidate])
  );
  useSTEvent(
    'chat:renamed',
    useCallback(() => invalidate(), [invalidate])
  );
  useSTEvent(
    'chat:changed',
    useCallback(() => invalidate(), [invalidate])
  );

  async function handleOpenChat(fileName: string, avatar: string) {
    if (!bridgeReady) return;
    try {
      await platformAction('openChat', { fileName, avatar });
      useSTMirrorStore.getState().updatePartial({ currentChatId: fileName });
      setOpen(false);
    } catch (err) {
      console.error('[ChatSidebar] openChat failed:', err);
    }
  }

  async function handleDeleteChat(fileName: string, avatar: string) {
    if (!bridgeReady) return;
    try {
      await platformAction('deleteChat', { fileName, avatar });
    } catch (err) {
      console.error('[ChatSidebar] deleteChat failed:', err);
    }
  }

  async function handleRenameChat(oldFileName: string, avatar: string) {
    if (!bridgeReady) return;
    const newName = prompt('新名称：');
    if (!newName?.trim()) return;
    try {
      const trimmed = newName.trim();
      await platformAction('renameChat', {
        oldFileName,
        newName: trimmed,
        avatar,
      });

      // Optimistic update: immediately reflect the new name in the store
      const { items } = useChatListStore.getState();
      const updatedItems = items.map((item) =>
        item.fileName === oldFileName && item.characterAvatar === avatar
          ? { ...item, fileName: trimmed }
          : item
      );
      useChatListStore.setState({ items: updatedItems });

      const { currentChatId: activeChatId } = useSTMirrorStore.getState();
      if (activeChatId === oldFileName) {
        useSTMirrorStore.getState().updatePartial({ currentChatId: trimmed });
      }

      // Fallback: force refresh in case the event-based invalidate doesn't fire
      invalidate();
    } catch (err) {
      console.error('[ChatSidebar] renameChat failed:', err);
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          className="rounded-full p-2 text-white/70 hover:text-white transition-colors"
          aria-label="历史对话"
        >
          <Ellipsis className="h-5 w-5" />
        </button>
      </SheetTrigger>
      <SheetContent side="left" className="flex flex-col p-0">
        <div className="flex items-center px-4 py-3 border-b border-border">
          <SheetTitle>历史对话</SheetTitle>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && items.length === 0 && (
            <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
              加载中...
            </div>
          )}

          {!loading && items.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground text-xs gap-1">
              <MessageSquare className="h-6 w-6 opacity-40" />
              <span>暂无对话记录</span>
            </div>
          )}

          {items.map((item) => {
            const isActive = currentChatId === item.fileName;
            const isRenamed = !AUTO_CHAT_NAME_RE.test(item.fileName);
            const primaryName = isRenamed ? item.fileName : item.characterName || item.fileName;
            const secondaryText = isRenamed
              ? `${item.characterName || ''} · ${item.lastMessage || '暂无消息'}`.replace(
                  /^ · /,
                  ''
                )
              : item.lastMessage || '暂无消息';

            return (
              <div
                key={`${item.characterAvatar}/${item.fileName}`}
                className={cn(
                  'group flex items-start gap-2 px-4 py-2.5 cursor-pointer transition-colors',
                  isActive ? 'bg-accent/60' : 'hover:bg-accent/30'
                )}
                onClick={() => handleOpenChat(item.fileName, item.characterAvatar)}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate">{primaryName}</div>
                  <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                    {secondaryText}
                  </div>
                </div>

                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    disabled={!bridgeReady}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRenameChat(item.fileName, item.characterAvatar);
                    }}
                    className="rounded p-1 text-muted-foreground/60 hover:text-foreground hover:bg-accent disabled:opacity-40"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    disabled={!bridgeReady}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteChat(item.fileName, item.characterAvatar);
                    }}
                    className="rounded p-1 text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10 disabled:opacity-40"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
