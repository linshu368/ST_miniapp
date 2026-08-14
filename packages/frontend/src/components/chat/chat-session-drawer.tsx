'use client';

import { Loader2, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import type { ChatSession } from '@miniapp/shared';

import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { resolveSessionTitle, useConversationsQuery } from '@/lib/api/conversations';
import {
  SessionActionButton,
  SessionDeleteConfirm,
  SessionRenameField,
  useSessionRowActions,
} from './session-row-actions';

interface ChatSessionDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  characterId: string;
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
}

/**
 * 「开启新对话」不在这里：它是工具箱里的一项，抽屉只负责列既有对话。
 * 同一个动作摆两处会让人以为是两件事。
 */
export function ChatSessionDrawer({
  open,
  onOpenChange,
  characterId,
  activeSessionId,
  onSelect,
}: ChatSessionDrawerProps) {
  // 抽屉关着时不查：会话列表只在用户主动翻的时候才需要新鲜
  const query = useConversationsQuery(characterId, open);
  const sessions = query.data?.sessions ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-[86vw] max-w-sm border-border bg-background p-0">
        <div className="flex h-full flex-col">
          <div className="border-b border-border px-4 py-4 pt-[calc(env(safe-area-inset-top)+1rem)]">
            <SheetTitle className="text-[16px] font-bold text-foreground">对话记录</SheetTitle>
            <SheetDescription className="mt-0.5 text-[12px] text-muted-foreground">
              与这个角色的历史对话
            </SheetDescription>
          </div>

          <div className="flex-1 space-y-1.5 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3">
            {query.isLoading ? (
              <div className="flex justify-center py-10 text-[12px] text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                加载中
              </div>
            ) : sessions.length === 0 ? (
              <p className="px-2 py-10 text-center text-[12px] text-muted-foreground">
                还没有对话记录
              </p>
            ) : (
              sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  active={session.id === activeSessionId}
                  onOpen={() => {
                    onSelect(session.id);
                    onOpenChange(false);
                  }}
                />
              ))
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * 标题回落到首条消息摘要，而不是像 /chats 那样回落到角色名：
 * 这里所有会话都是同一个角色，写角色名等于每行都一样，区分不了任何东西。
 */
function SessionRow({
  session,
  active,
  onOpen,
}: {
  session: ChatSession;
  active: boolean;
  onOpen: () => void;
}) {
  const actions = useSessionRowActions(session);

  return (
    <div
      className={cn(
        'rounded-xl border px-3 py-2.5 transition-colors',
        active ? 'border-primary/40 bg-primary/10' : 'border-border bg-card'
      )}
    >
      {actions.editing ? (
        <SessionRenameField actions={actions} density="compact" />
      ) : (
        <div className="flex items-center gap-1">
          <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
            <span className="flex min-w-0 items-center gap-1">
              {session.pinned_at ? (
                <Pin className="size-3 shrink-0 fill-current text-primary" aria-label="已置顶" />
              ) : null}
              <span className="truncate text-[13px] font-medium text-foreground">
                {resolveSessionTitle(session.title, session.last_message_preview)}
              </span>
            </span>
            <span className="mt-0.5 block text-[11px] text-muted-foreground">
              {formatSessionMeta(session)}
            </span>
          </button>
          <SessionActionButton
            label={session.pinned_at ? '取消置顶' : '置顶'}
            onClick={actions.togglePin}
            density="compact"
          >
            {session.pinned_at ? <PinOff aria-hidden /> : <Pin aria-hidden />}
          </SessionActionButton>
          <SessionActionButton label="重命名" onClick={actions.startRename} density="compact">
            <Pencil aria-hidden />
          </SessionActionButton>
          <SessionActionButton label="删除" onClick={actions.toggleDeleteConfirm} density="compact">
            <Trash2 aria-hidden />
          </SessionActionButton>
        </div>
      )}

      {actions.confirmingDelete ? (
        <SessionDeleteConfirm actions={actions} density="compact" />
      ) : null}
    </div>
  );
}

function formatSessionMeta(session: ChatSession): string {
  const count = `${session.message_count} 条`;
  if (!session.last_message_at) return count;

  const at = new Date(session.last_message_at);
  if (Number.isNaN(at.getTime())) return count;

  const now = new Date();
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();

  const stamp = sameDay
    ? at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });

  return `${stamp} · ${count}`;
}
