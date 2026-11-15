'use client';

import { useState } from 'react';
import {
  GitBranch,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { ChatSession } from '@miniapp/shared';

import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useConversationsQuery } from '@/lib/api/conversations';
import {
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
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) setExpandedSessionId(null);
        onOpenChange(next);
      }}
    >
      <SheetContent
        side="left"
        className="w-[86vw] max-w-[340px] border-border/70 bg-background p-0"
      >
        <div className="flex h-full flex-col">
          <div className="border-b border-border/60 px-5 pb-4 pt-[calc(env(safe-area-inset-top)+1rem)]">
            <SheetTitle className="text-base font-semibold text-foreground">对话记录</SheetTitle>
            <SheetDescription className="mt-1.5 truncate pr-8 text-xs text-muted-foreground">
              {characterName?.trim() || '与这个角色的历史对话'}
            </SheetDescription>
          </div>

          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
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
                <span>还没有对话，去找个角色聊聊吧</span>
              </div>
            ) : null}
            {sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                characterName={characterName}
                active={session.id === activeSessionId}
                expanded={expandedSessionId === session.id}
                onExpandedChange={(next) => setExpandedSessionId(next ? session.id : null)}
                onOpen={() => {
                  setExpandedSessionId(null);
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

/** 默认会话名仅在此处用创建时间区分，不能改写用户名称或改变其他列表的展示。 */
function SessionRow({
  session,
  characterName,
  active,
  expanded,
  onExpandedChange,
  onOpen,
}: {
  session: ChatSession;
  characterName?: string | null;
  active: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onOpen: () => void;
}) {
  const actions = useSessionRowActions(session);
  const defaultTitle = hasDefaultTitle(session, characterName);
  const title = defaultTitle ? formatCreatedTitle(session.created_at) : session.title!.trim();
  const toolsOpen = expanded && !actions.confirmingDelete;
  const menuButtonClass =
    'flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0';

  return (
    <div
      data-testid={`session-row-${session.id}`}
      className={cn(
        'rounded-2xl border px-3 py-3 transition-colors',
        active ? 'border-primary/20 bg-primary/[0.07]' : 'border-transparent hover:bg-muted/60'
      )}
    >
      {actions.editing ? (
        <div className="[&_button]:size-11 [&_input]:min-h-11 [&_input]:text-base">
          <SessionRenameField
            actions={actions}
            density="compact"
            placeholder="给这段对话起个名字"
          />
        </div>
      ) : (
        <>
          <div className="flex items-start gap-1">
            <button
              type="button"
              onClick={onOpen}
              aria-label={`打开对话：${title}`}
              aria-current={active ? 'true' : undefined}
              className="min-h-11 min-w-0 flex-1 rounded-lg py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span className="flex min-w-0 items-start gap-1.5">
                {session.pinned_at ? (
                  <Pin
                    className="mt-1 size-3 shrink-0 fill-current text-primary/80"
                    aria-label="已置顶"
                  />
                ) : null}
                <span className="line-clamp-2 break-words text-sm font-medium leading-5 text-foreground">
                  {title}
                </span>
              </span>
              <span className="mt-1.5 block truncate text-xs leading-5 text-muted-foreground">
                {session.last_message_preview || '继续这段对话'}
              </span>
              <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] leading-4 text-muted-foreground/75">
                {active ? <span className="font-medium text-primary/90">当前</span> : null}
                {session.branch ? (
                  <span className="inline-flex items-center gap-1">
                    <GitBranch className="size-3" aria-hidden />
                    从第{session.branch.source_turn_index}轮分出
                  </span>
                ) : null}
                <span>{formatSessionMeta(session)}</span>
              </span>
            </button>
            <button
              type="button"
              aria-label="更多操作"
              aria-expanded={toolsOpen}
              aria-controls={`session-tools-${session.id}`}
              disabled={actions.pending}
              onClick={() => {
                actions.cancelDelete();
                onExpandedChange(!toolsOpen);
              }}
              className={cn(
                '-mr-1 flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50',
                toolsOpen && 'bg-secondary text-foreground'
              )}
            >
              <MoreHorizontal className="size-[18px]" aria-hidden />
            </button>
          </div>
          {toolsOpen ? (
            <div
              id={`session-tools-${session.id}`}
              className="mt-2 grid grid-cols-3 gap-0.5 border-t border-border/50 pt-2"
            >
              <button
                type="button"
                disabled={actions.pending}
                className={menuButtonClass}
                onClick={() => {
                  actions.startRename();
                  if (defaultTitle) actions.setDraft('');
                  onExpandedChange(false);
                }}
              >
                <Pencil aria-hidden />
                重命名
              </button>
              <button
                type="button"
                disabled={actions.pending}
                className={menuButtonClass}
                onClick={() => {
                  actions.togglePin();
                  onExpandedChange(false);
                }}
              >
                {session.pinned_at ? <PinOff aria-hidden /> : <Pin aria-hidden />}
                {session.pinned_at ? '取消置顶' : '置顶'}
              </button>
              <button
                type="button"
                disabled={actions.pending}
                className={menuButtonClass}
                onClick={() => {
                  actions.toggleDeleteConfirm();
                  onExpandedChange(false);
                }}
              >
                <Trash2 aria-hidden />
                删除
              </button>
            </div>
          ) : null}
        </>
      )}
      {actions.error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {actions.error}
        </p>
      ) : null}
      {actions.confirmingDelete ? (
        <SessionDeleteConfirm actions={actions} density="compact" className="[&_button]:min-h-11" />
      ) : null}
    </div>
  );
}

function hasDefaultTitle(session: ChatSession, characterName?: string | null): boolean {
  const title = session.title?.trim();
  const name = characterName?.trim();
  if (!title || (name && title === name)) return true;
  // 分支可能继承用户自定义名称，不能仅凭“分支”前缀把所有名称替换掉。
  if (!session.branch) return false;
  return (
    title === '分支 · 新的对话' ||
    Boolean(name && title === `分支 · ${Array.from(name).slice(0, 55).join('')}`)
  );
}

function formatCreatedTitle(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '未命名对话';
  const day = date.toLocaleDateString('zh-CN', {
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}),
    month: 'long',
    day: 'numeric',
  });
  const time = date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${day} · ${time}`;
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

  return `最近 ${stamp} · ${count}`;
}
