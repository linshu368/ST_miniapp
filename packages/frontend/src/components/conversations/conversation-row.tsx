'use client';

import { useMemo, useRef } from 'react';
import Link from 'next/link';
import {
  Check,
  Ellipsis,
  FolderInput,
  MessageCircle,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react';
import { DEFAULT_LOBBY_SORT, type CharacterSummary, type ChatSession } from '@miniapp/shared';

import { lobbyImageUrl } from '@/components/characters/character-card';
import { ReturnFlash } from '@/components/ui/return-flash';
import {
  SessionDeleteConfirm,
  SessionRenameField,
  useSessionRowActions,
  type SessionRowActions,
} from '@/components/chat/session-row-actions';
import { useCharacterQuery, useCharactersQuery } from '@/lib/api/characters';
import { resolveSessionTitle } from '@/lib/api/conversations';
import { chatEntryPath } from '@/lib/chat-entry';
import { rememberRoleplayScroll } from '@/lib/roleplay-navigation';
import { cn } from '@/lib/utils';

export type LobbySummaryLookup =
  | { status: 'pending' }
  | { status: 'ready'; byId: ReadonlyMap<string, CharacterSummary> }
  | { status: 'unavailable' };

/**
 * 会话列表只带 character_id；头像和名字先查大厅摘要（通常已在本地缓存），
 * 查不到（下架或大厅读失败）才逐行回退详情。原来每行各拉一次详情，20 行就是 20 个请求（ST-MINIAPP-1Y）。
 */
export function useLobbySummaryLookup(): LobbySummaryLookup {
  const lobby = useCharactersQuery(DEFAULT_LOBBY_SORT);
  const characters = lobby.data?.characters;
  return useMemo<LobbySummaryLookup>(() => {
    if (characters) return { status: 'ready', byId: new Map(characters.map((c) => [c.id, c])) };
    return lobby.isError ? { status: 'unavailable' } : { status: 'pending' };
  }, [characters, lobby.isError]);
}

export function useSessionCharacter(session: ChatSession, lookup: LobbySummaryLookup) {
  const summary =
    lookup.status === 'ready' && !session.character_version_id
      ? lookup.byId.get(session.character_id)
      : undefined;
  // 大厅摘要还在读时先不发详情，否则冷启动又退化成 N 个请求。
  const { data } = useCharacterQuery(session.character_id, {
    enabled: lookup.status !== 'pending' && !summary,
    sessionId: session.id,
  });
  return summary ?? data?.character;
}

export function SessionAvatar({ url, small }: { url: string | null; small?: boolean }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden bg-secondary text-primary',
        small ? 'size-10 rounded-xl' : 'size-12 rounded-2xl'
      )}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" loading="lazy" className="size-full object-cover object-top" />
      ) : (
        <MessageCircle className="size-5" aria-hidden />
      )}
    </span>
  );
}

export function formatActivityTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export interface ConversationRowProps {
  session: ChatSession;
  lookup: LobbySummaryLookup;
  /** 「全部」与搜索结果里标出所属分组，分组内不重复显示 */
  folderLabel?: string;
  /** 管理模式：整行用于勾选，不进聊天、不显示菜单 */
  selection?: { selected: boolean; onToggle: () => void };
  onMove: (session: ChatSession) => void;
  /** 展开在角色组里的段落：头像略小、去阴影 */
  nested?: boolean;
  /** 点开前记下位置，返回时回到这一行 */
  onOpen?: (sessionId: string) => void;
  /** 刚从这段对话返回：闪一下金边 */
  flash?: boolean;
}

export function ConversationRow({
  session,
  lookup,
  folderLabel,
  selection,
  onMove,
  nested,
  onOpen,
  flash,
}: ConversationRowProps) {
  const character = useSessionCharacter(session, lookup);
  const actions = useSessionRowActions(session);
  const avatarUrl = character?.avatar_url ? lobbyImageUrl(character.avatar_url) : null;
  // 展开在角色组里时角色名已在上面，标题是区分各段的唯一线索，不按 7 字截断。
  const name = nested
    ? session.title?.trim() || character?.name || '对话'
    : resolveSessionTitle(session.title, character?.name ?? '对话');

  if (actions.editing) {
    return (
      <article className="rounded-3xl border border-primary/30 bg-card p-3.5">
        <SessionRenameField actions={actions} />
        <RowFeedback actions={actions} />
      </article>
    );
  }

  const body = (
    <>
      {selection ? <SelectMark selected={selection.selected} /> : null}
      <SessionAvatar url={avatarUrl} small={nested} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1">
          {session.pinned_at ? (
            <Pin className="size-3 shrink-0 fill-current text-primary" aria-label="已置顶" />
          ) : null}
          <span className="truncate text-sm font-semibold">{name}</span>
          {folderLabel ? (
            <span className="max-w-[5.5rem] shrink-0 truncate rounded-md bg-secondary px-1.5 py-px text-[10px] font-medium text-muted-foreground">
              {folderLabel}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
          {nested ? null : <span className="truncate">{character?.name ?? '角色对话'}</span>}
          <time className="shrink-0">
            {formatActivityTime(session.last_message_at ?? session.created_at)}
          </time>
          {nested ? <span className="shrink-0">{session.message_count} 轮</span> : null}
        </span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {session.last_message_preview || '还没聊几句'}
        </span>
      </span>
    </>
  );

  return (
    <article
      data-chat-anchor={session.id}
      className={cn(
        'relative border bg-card transition-colors',
        nested ? 'rounded-2xl p-3' : 'rounded-3xl p-3.5 shadow-lg shadow-black/10',
        selection?.selected
          ? 'border-primary/60 bg-primary/[0.06]'
          : session.pinned_at
            ? 'border-primary/30'
            : 'border-border'
      )}
      aria-busy={actions.pending}
    >
      <div className="flex items-center gap-1">
        {selection ? (
          <button
            type="button"
            aria-pressed={selection.selected}
            aria-label={`${selection.selected ? '取消选择' : '选择'}：${name}`}
            onClick={selection.onToggle}
            className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {body}
          </button>
        ) : (
          <Link
            href={chatEntryPath(session.character_id, {
              sessionId: session.id,
              source: 'conversations',
            })}
            prefetch={false}
            onClick={() => {
              rememberRoleplayScroll('/chats');
              onOpen?.(session.id);
            }}
            aria-label={`继续与 ${name} 的对话`}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {body}
          </Link>
        )}
        {selection ? null : (
          <RowMenu name={name} session={session} actions={actions} onMove={onMove} />
        )}
      </div>
      {actions.confirmingDelete ? <SessionDeleteConfirm actions={actions} /> : null}
      <RowFeedback actions={actions} />
      {flash ? <ReturnFlash className={nested ? 'rounded-2xl' : 'rounded-3xl'} /> : null}
    </article>
  );
}

function SelectMark({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'mr-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors',
        selected
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-muted-foreground/60'
      )}
    >
      {selected ? <Check className="size-3.5" strokeWidth={3} /> : null}
    </span>
  );
}

function RowFeedback({ actions }: { actions: SessionRowActions }) {
  return (
    <>
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
    </>
  );
}

const MENU_ITEM =
  'flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-xs hover:bg-secondary disabled:opacity-50';

function RowMenu({
  name,
  session,
  actions,
  onMove,
}: {
  name: string;
  session: ChatSession;
  actions: SessionRowActions;
  onMove: (session: ChatSession) => void;
}) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const act = (action: () => void) => {
    if (menuRef.current) menuRef.current.open = false;
    action();
  };
  return (
    <details
      ref={menuRef}
      className="relative shrink-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
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
          className={MENU_ITEM}
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
          onClick={() => act(() => onMove(session))}
          className={MENU_ITEM}
        >
          <FolderInput className="size-4" aria-hidden />
          移到分组
        </button>
        <button
          type="button"
          disabled={actions.pending}
          onClick={() => act(actions.startRename)}
          className={MENU_ITEM}
        >
          <Pencil className="size-4" aria-hidden />
          重命名
        </button>
        <button
          type="button"
          disabled={actions.pending}
          onClick={() => act(actions.toggleDeleteConfirm)}
          className={cn(MENU_ITEM, 'text-destructive')}
        >
          <Trash2 className="size-4" aria-hidden />
          删除
        </button>
      </div>
    </details>
  );
}
