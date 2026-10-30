'use client';

import {
  GitBranch,
  Loader2,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Trash2,
} from 'lucide-react';
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
  characterName?: string | null;
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
  characterName,
  activeSessionId,
  onSelect,
}: ChatSessionDrawerProps) {
  // 抽屉关着时不查：会话列表只在用户主动翻的时候才需要新鲜
  const query = useConversationsQuery(characterId, open);
  const sessions = query.data?.sessions ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="w-[86vw] max-w-[340px] border-border/70 bg-background p-0"
      >
        <div className="flex h-full flex-col">
          <div className="border-b border-border/60 px-5 pb-4 pt-[calc(env(safe-area-inset-top)+1rem)]">
            <SheetTitle className="text-base font-semibold text-foreground">对话记录</SheetTitle>
            <SheetDescription className="mt-0.5 text-xs text-muted-foreground">
              与这个角色的历史对话
            </SheetDescription>
          </div>

          <div className="flex-1 space-y-1 overflow-y-auto p-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
            {query.isError ? (
              <div className="mx-1 mb-2 rounded-2xl border border-destructive/25 bg-destructive/5 px-3 py-3">
                <p className="text-xs text-muted-foreground" role="alert">
                  {sessions.length > 0
                    ? '暂时没能刷新，已保留之前的对话记录。'
                    : '对话记录没能加载出来，请重试。'}
                </p>
                <button
                  type="button"
                  disabled={query.isFetching}
                  onClick={() => void query.refetch()}
                  className="mt-2 inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-xs text-primary hover:bg-primary/10 disabled:opacity-50"
                >
                  <RefreshCw className="size-3.5" aria-hidden />
                  {query.isFetching ? '重试中…' : '重新加载'}
                </button>
              </div>
            ) : null}
            {query.isLoading && sessions.length === 0 ? (
              <div
                className="flex items-center justify-center py-8 text-xs text-muted-foreground"
                role="status"
              >
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                加载中
              </div>
            ) : !query.isError && sessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-1 py-8 text-xs text-muted-foreground">
                <MessageSquare className="h-6 w-6 opacity-40" aria-hidden />
                <span>暂无对话记录</span>
              </div>
            ) : null}
            {sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                characterName={characterName}
                active={session.id === activeSessionId}
                onOpen={() => {
                  onSelect(session.id);
                  onOpenChange(false);
                }}
              />
            ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * 行的几何按原版 ST 链路的侧边栏（components/tavern/chat-sidebar.tsx）取值：
 * rounded-2xl、px-3 py-3、选中态 border-primary/20 + bg-primary/10、
 * 主文案 text-sm font-medium、副文案 mt-1 text-xs muted。
 *
 * 操作按钮没跟着还原成原版的 12px 图标 + p-1 方形热区：原版只有重命名和删除
 * 两个（且重命名走的是 window.prompt、删除没有二次确认），这里是三个按钮外加
 * 行内改名输入框和删除确认条，20px 的热区在手机上点不准。
 *
 * 标题展示绑定角色名前 7 字：这里所有会话都是同一个角色，用户没重命名时
 * 各行标题会相同，靠时间和预览区分；重命名后才是用户自己的名字。
 */
function SessionRow({
  session,
  characterName,
  active,
  onOpen,
}: {
  session: ChatSession;
  characterName?: string | null;
  active: boolean;
  onOpen: () => void;
}) {
  const actions = useSessionRowActions(session);

  return (
    <div
      className={cn(
        'rounded-2xl border px-3 py-3 transition-colors',
        active ? 'border-primary/20 bg-primary/10' : 'border-transparent hover:bg-muted'
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
              {session.branch ? (
                <GitBranch
                  className="size-3 shrink-0 text-muted-foreground"
                  aria-label="分支对话"
                />
              ) : null}
              <span className="truncate text-sm font-medium text-foreground">
                {resolveSessionTitle(session.title, characterName)}
              </span>
            </span>
            <span className="mt-1 block truncate text-xs text-muted-foreground">
              {session.last_message_preview || '继续这段对话'}
            </span>
            <span className="mt-1 block text-[10px] text-muted-foreground/75">
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

      {actions.error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {actions.error}
        </p>
      ) : null}
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
