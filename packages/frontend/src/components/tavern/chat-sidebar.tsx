'use client';

import { useEffect, useState, useCallback } from 'react';
import { Menu, Plus, Trash2, Pencil, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Sheet, SheetTrigger, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { platformAction, useBridgeStatus, useSTEvent, useSTMirror } from '@/lib/bridge';
import { useChatListStore } from '@/stores/chat-list';

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

  async function handleNewChat() {
    if (!bridgeReady) return;
    try {
      await platformAction('newChat', {});
      setOpen(false);
    } catch (err) {
      console.error('[ChatSidebar] newChat failed:', err);
    }
  }

  async function handleOpenChat(fileName: string) {
    if (!bridgeReady) return;
    try {
      await platformAction('openChat', { fileName });
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

  async function handleRenameChat(oldFileName: string) {
    if (!bridgeReady) return;
    const newName = prompt('新名称：');
    if (!newName?.trim()) return;
    try {
      await platformAction('renameChat', { oldFileName, newName: newName.trim() });
    } catch (err) {
      console.error('[ChatSidebar] renameChat failed:', err);
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button className="rounded-full bg-black/40 backdrop-blur-sm p-2 text-white/80 hover:text-white transition-colors">
          <Menu className="h-4 w-4" />
        </button>
      </SheetTrigger>
      <SheetContent side="left" className="flex flex-col p-0">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <SheetTitle>历史对话</SheetTitle>
          <button
            disabled={!bridgeReady}
            onClick={handleNewChat}
            className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus className="h-4 w-4" />
          </button>
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
            return (
              <div
                key={item.fileName}
                className={cn(
                  'group flex items-start gap-2 px-4 py-2.5 cursor-pointer transition-colors',
                  isActive ? 'bg-accent/60' : 'hover:bg-accent/30'
                )}
                onClick={() => handleOpenChat(item.fileName)}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate">
                    {item.characterName || item.fileName}
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                    {item.lastMessage || '暂无消息'}
                  </div>
                </div>

                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <button
                    disabled={!bridgeReady}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRenameChat(item.fileName);
                    }}
                    className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    disabled={!bridgeReady}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteChat(item.fileName, item.characterAvatar);
                    }}
                    className="rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-40"
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
