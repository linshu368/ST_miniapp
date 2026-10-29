'use client';

import { useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import { Ellipsis, MessageCircle, Pencil, Pin, PinOff, RefreshCw, Trash2 } from 'lucide-react';

import { DEFAULT_LOBBY_SORT } from '@miniapp/shared';
import type { CharacterSummary, ChatSession } from '@miniapp/shared';

import {
  SessionDeleteConfirm,
  SessionRenameField,
  useSessionRowActions,
} from '@/components/chat/session-row-actions';
import { lobbyImageUrl } from '@/components/characters/character-card';
import { RoleplayHeader } from '@/components/roleplay/roleplay-header';
import { useCharacterQuery, useCharactersQuery } from '@/lib/api/characters';
import { resolveSessionTitle, useConversationsQuery } from '@/lib/api/conversations';
import { chatEntryPath } from '@/lib/chat-entry';
import { usePageReady } from '@/lib/perf/page-ready';
import {
  rememberRoleplayScroll,
  rememberRoleplayView,
  restoreRoleplayScroll,
} from '@/lib/roleplay-navigation';
import { cn } from '@/lib/utils';

export default function ChatsPage() {
  return (
    <main className="min-h-[calc(100dvh-var(--app-nav-space))] bg-background pb-8 text-foreground">
      <RoleplayHeader active="conversations" />
      <ConversationHistoryList />
    </main>
  );
}

type LobbySummaryLookup =
  | { status: 'pending' }
  | { status: 'ready'; byId: ReadonlyMap<string, CharacterSummary> }
  | { status: 'unavailable' };

function ConversationHistoryList() {
  const { data, isLoading, isError, refetch } = useConversationsQuery(undefined);
  const sessions = data?.sessions ?? [];
  usePageReady('/chats', data !== undefined && (!isError || sessions.length > 0), false, isError);
  // 历史行只要头像和名字。原来每行各拉一次详情，20 行就是 20 个请求（Sentry ST-MINIAPP-1Y）。
  // 先查大厅摘要（通常已在 localStorage），只有查不到的卡（下架、或大厅读失败）才回退到详情。
  // 不重拉：这里只借头像，大厅自己进页面时会对齐数据库。
  const lobby = useCharactersQuery(DEFAULT_LOBBY_SORT, { skipMountRefetch: true });
  const lobbyCharacters = lobby.data?.characters;
  const lookup = useMemo<LobbySummaryLookup>(() => {
    if (lobbyCharacters) {
      return { status: 'ready', byId: new Map(lobbyCharacters.map((c) => [c.id, c])) };
    }
    return lobby.isError ? { status: 'unavailable' } : { status: 'pending' };
  }, [lobbyCharacters, lobby.isError]);

  const restored = useRef(false);

  useEffect(() => {
    if (!data || restored.current) return;
    restored.current = true;
    restoreRoleplayScroll('/chats');
  }, [data]);

  return (
    <section aria-label="对话记录" className="mx-auto w-full max-w-2xl space-y-2 px-4 pt-1">
      <p className="pb-2 text-xs text-muted-foreground">继续你的故事，也可以在这里管理对话。</p>
      {isLoading && sessions.length === 0 ? <HistoryHint>正在读取历史对话…</HistoryHint> : null}
      {isError ? <HistoryError onRetry={() => void refetch()} /> : null}
      {!isLoading && !isError && sessions.length === 0 ? <HistoryEmpty /> : null}
      {sessions.map((session) => (
        <ConversationHistoryRow key={session.id} session={session} lookup={lookup} />
      ))}
    </section>
  );
}

/**
 * 会话列表只带 character_id。取角色卡只为头像；
 * 主标题走 session.title（缺省时退到角色名），展示时统一截到 7 字。
 *
 * 整行是进入聊天的链接，操作按钮浮在它上层单独响应，避免 Link 里嵌 button。
 */
function ConversationHistoryRow({
  session,
  lookup,
}: {
  session: ChatSession;
  lookup: LobbySummaryLookup;
}) {
  const summary = lookup.status === 'ready' ? lookup.byId.get(session.character_id) : undefined;
  // 大厅摘要还在读时先不发详情，否则冷启动又退化成 N 个请求。
  const needsDetail = lookup.status !== 'pending' && !summary;
  const { data } = useCharacterQuery(session.character_id, { enabled: needsDetail });
  const character = summary ?? data?.character;
  const actions = useSessionRowActions(session);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const avatarUrl = character?.avatar_url ? lobbyImageUrl(character.avatar_url) : null;
  const name = resolveSessionTitle(session.title, character?.name ?? '对话');

  const act = (action: () => void) => {
    if (menuRef.current) menuRef.current.open = false;
    action();
  };

  if (actions.editing) {
    return (
      <article className="rounded-3xl border border-primary/30 bg-card p-3.5">
        <SessionRenameField actions={actions} />
        {actions.error ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {actions.error}
          </p>
        ) : null}
      </article>
    );
  }

  return (
    <article
      className={cn(
        'rounded-3xl border bg-card p-3.5 shadow-lg shadow-black/10 transition-colors',
        session.pinned_at ? 'border-primary/30' : 'border-border'
      )}
      aria-busy={actions.pending}
    >
      <div className="flex items-center gap-1">
        <Link
          href={chatEntryPath(session.character_id, {
            sessionId: session.id,
            source: 'conversations',
          })}
          prefetch={false}
          onClick={() => {
            rememberRoleplayView('/chats');
            rememberRoleplayScroll('/chats');
          }}
          aria-label={`继续与 ${name} 的对话`}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-secondary text-primary">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt=""
                loading="lazy"
                className="size-full object-cover object-top"
              />
            ) : (
              <MessageCircle className="size-5" aria-hidden />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1">
              {session.pinned_at ? (
                <Pin className="size-3 shrink-0 fill-current text-primary" aria-label="已置顶" />
              ) : null}
              <span className="truncate text-sm font-semibold">{name}</span>
            </span>
            <span className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
              <span className="truncate">{character?.name ?? '角色对话'}</span>
              <time className="shrink-0">
                {formatActivityTime(session.last_message_at ?? session.created_at)}
              </time>
            </span>
            <span className="mt-1 block truncate text-xs text-muted-foreground">
              {session.last_message_preview || '暂无消息摘要'}
            </span>
          </span>
        </Link>

        <details
          ref={menuRef}
          className="relative shrink-0"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              event.currentTarget.open = false;
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || !event.currentTarget.open) return;
            event.preventDefault();
            event.currentTarget.open = false;
            event.currentTarget.querySelector('summary')?.focus();
          }}
        >
          <summary
            aria-label={`管理对话：${name}`}
            className="flex size-11 cursor-pointer list-none items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
          >
            <Ellipsis className="size-5" aria-hidden />
          </summary>
          <div className="absolute right-0 top-12 z-20 min-w-40 rounded-2xl border border-border bg-card p-1.5 shadow-xl">
            <button
              type="button"
              disabled={actions.pending}
              onClick={() => act(actions.togglePin)}
              className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-xs hover:bg-secondary disabled:opacity-50"
            >
              {session.pinned_at ? (
                <PinOff className="size-4" aria-hidden />
              ) : (
                <Pin className="size-4" aria-hidden />
              )}
              {session.pinned_at ? '取消置顶' : '置顶'}
            </button>
            <button
              type="button"
              disabled={actions.pending}
              onClick={() => act(actions.startRename)}
              className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-xs hover:bg-secondary disabled:opacity-50"
            >
              <Pencil className="size-4" aria-hidden />
              重命名
            </button>
            <button
              type="button"
              disabled={actions.pending}
              onClick={() => act(actions.toggleDeleteConfirm)}
              className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-xs text-destructive hover:bg-secondary disabled:opacity-50"
            >
              <Trash2 className="size-4" aria-hidden />
              删除
            </button>
          </div>
        </details>
      </div>

      {actions.confirmingDelete ? <SessionDeleteConfirm actions={actions} /> : null}
      {actions.pending ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          正在保存…
        </p>
      ) : null}
      {actions.error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {actions.error}
        </p>
      ) : null}
    </article>
  );
}

function HistoryHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-3xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function HistoryError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-3xl border border-destructive/30 bg-destructive/10 p-5">
      <p className="text-sm text-destructive">历史对话加载失败，请稍后重试。</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition active:scale-95"
      >
        <RefreshCw className="size-4" aria-hidden />
        重试
      </button>
    </div>
  );
}

function HistoryEmpty() {
  return (
    <div className="rounded-3xl border border-border bg-card p-8 text-center">
      <MessageCircle className="mx-auto size-9 text-primary" aria-hidden />
      <h2 className="mt-3 font-semibold">还没有对话</h2>
      <p className="mt-1 text-sm text-muted-foreground">选一个喜欢的角色，开始你的第一段故事。</p>
      <Link
        href="/characters"
        onClick={() => rememberRoleplayView('/characters')}
        className="mt-4 inline-flex min-h-11 items-center rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition active:scale-95"
      >
        去发现角色
      </Link>
    </div>
  );
}

function formatActivityTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
