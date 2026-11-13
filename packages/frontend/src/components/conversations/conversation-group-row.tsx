'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Ellipsis, FolderInput, Pin, PinOff, RefreshCw } from 'lucide-react';
import type { ChatSession, ConversationGroup } from '@miniapp/shared';

import { lobbyImageUrl } from '@/components/characters/character-card';
import { ReturnFlash } from '@/components/ui/return-flash';
import {
  characterSessionsOptions,
  useCharacterSessions,
  type FolderFilter,
} from '@/lib/api/conversation-folders';
import { resolveSessionTitle } from '@/lib/api/conversations';
import { chatEntryPath } from '@/lib/chat-entry';
import { rememberRoleplayScroll } from '@/lib/roleplay-navigation';
import { cn } from '@/lib/utils';
import {
  ConversationRow,
  SessionAvatar,
  formatActivityTime,
  useSessionCharacter,
  type LobbySummaryLookup,
} from './conversation-row';

/** 整组操作只有置顶和移到分组：改名、删除针对的是具体某段，留在展开后的单段上。 */
export interface GroupActions {
  move: (ids: string[], subject: string) => void;
  pin: (ids: string[], unpin: boolean) => void;
  fail: (message: string) => void;
}

/**
 * 「按角色」模式的一行：同一角色的多段对话收成一张叠卡。
 * 点卡片主体直接接着聊最近一段（和平铺时点第一行一样快）；点「N 段」才展开每一段。
 * 段落可能分散在不同分组，所以这里不标分组小标签，免得只代表最近那段。
 */
export function ConversationGroupRow({
  group,
  folder,
  lookup,
  onMove,
  groupActions,
  open,
  onToggle,
  onOpen,
  flashId,
}: {
  group: ConversationGroup;
  folder: FolderFilter;
  lookup: LobbySummaryLookup;
  onMove: (session: ChatSession) => void;
  groupActions: GroupActions;
  /** 展开状态由页面持有，返回时才能原样恢复 */
  open: boolean;
  onToggle: () => void;
  onOpen: (sessionId: string) => void;
  flashId: string | null;
}) {
  const lead = group.session;
  const pinned = Boolean(group.pinned_at);
  const character = useSessionCharacter(lead, lookup);
  const avatarUrl = character?.avatar_url ? lobbyImageUrl(character.avatar_url) : null;
  const characterName = character?.name ?? resolveSessionTitle(lead.title, '角色对话');
  const leadTitle = lead.title?.trim();
  // 标题就是角色名时不必重复，只说「最近一段」。
  const latest = leadTitle && leadTitle !== characterName ? `最近：${leadTitle}` : '最近一段';

  return (
    <div className={cn('relative', open ? null : 'pb-2')}>
      {open ? null : <StackEdges />}
      <article
        data-chat-anchor={lead.id}
        className={cn(
          'relative rounded-3xl border bg-card p-3.5 shadow-lg shadow-black/10',
          pinned ? 'border-primary/30' : 'border-border'
        )}
      >
        <div className="flex items-center gap-1">
          <Link
            href={chatEntryPath(lead.character_id, { sessionId: lead.id, source: 'conversations' })}
            prefetch={false}
            onClick={() => {
              rememberRoleplayScroll('/chats');
              onOpen(lead.id);
            }}
            aria-label={`接着聊 ${characterName} 最近的一段`}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <SessionAvatar url={avatarUrl} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1">
                {pinned ? (
                  <Pin className="size-3 shrink-0 fill-current text-primary" aria-label="已置顶" />
                ) : null}
                <span className="truncate text-sm font-semibold">{characterName}</span>
              </span>
              <span className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="truncate">{latest}</span>
                <time className="shrink-0">
                  {formatActivityTime(lead.last_message_at ?? lead.created_at)}
                </time>
              </span>
              <span className="mt-1 block truncate text-xs text-muted-foreground">
                {lead.last_message_preview || '还没聊几句'}
              </span>
            </span>
          </Link>
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? '收起' : '展开'} ${characterName} 的 ${group.session_count} 段对话`}
            onClick={onToggle}
            className="inline-flex min-h-11 shrink-0 items-center gap-0.5 rounded-full pl-2 pr-1 text-xs font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {group.session_count} 段
            <ChevronDown
              className={cn(
                'size-4 transition-transform duration-200 motion-reduce:transition-none',
                open && 'rotate-180'
              )}
              aria-hidden
            />
          </button>
          <GroupMenu
            characterName={characterName}
            characterId={lead.character_id}
            count={group.session_count}
            pinned={pinned}
            folder={folder}
            actions={groupActions}
          />
        </div>
        {flashId === lead.id ? <ReturnFlash className="rounded-3xl" /> : null}
      </article>
      {open ? (
        <GroupParts
          characterName={characterName}
          characterId={lead.character_id}
          folder={folder}
          lookup={lookup}
          onMove={onMove}
          onOpen={onOpen}
          flashId={flashId}
        />
      ) : null}
    </div>
  );
}

const MENU_ITEM =
  'flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-xs hover:bg-secondary disabled:opacity-50';

/** 整组的「⋯」：先取这个角色在当前范围里的全部段落，再交给批量接口。 */
function GroupMenu({
  characterName,
  characterId,
  count,
  pinned,
  folder,
  actions,
}: {
  characterName: string;
  characterId: string;
  count: number;
  pinned: boolean;
  folder: FolderFilter;
  actions: GroupActions;
}) {
  const queryClient = useQueryClient();
  const menuRef = useRef<HTMLDetailsElement>(null);
  const [busy, setBusy] = useState(false);
  const withIds = async (run: (ids: string[]) => void) => {
    if (menuRef.current) menuRef.current.open = false;
    setBusy(true);
    try {
      const data = await queryClient.fetchQuery(characterSessionsOptions(characterId, folder));
      run(data.sessions.map((session) => session.id));
    } catch {
      actions.fail('读取这个角色的对话失败，请重试');
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      ref={menuRef}
      className="relative shrink-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
      }}
    >
      <summary
        aria-label={`管理角色：${characterName}`}
        aria-busy={busy}
        className="flex size-11 cursor-pointer list-none items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
      >
        <Ellipsis className="size-5" aria-hidden />
      </summary>
      <div className="absolute right-0 top-12 z-20 min-w-44 rounded-2xl border border-border bg-card p-1.5 shadow-xl">
        <button
          type="button"
          disabled={busy}
          onClick={() => void withIds((ids) => actions.pin(ids, pinned))}
          className={MENU_ITEM}
        >
          {pinned ? (
            <PinOff className="size-4" aria-hidden />
          ) : (
            <Pin className="size-4" aria-hidden />
          )}
          {pinned ? '取消置顶这个角色' : '置顶这个角色'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void withIds((ids) => actions.move(ids, `「${characterName}」的 ${count} 段对话`))
          }
          className={MENU_ITEM}
        >
          <FolderInput className="size-4" aria-hidden />
          整组移到分组
        </button>
      </div>
    </details>
  );
}

/** 卡片底下露出两层薄边，一眼看出「这里面不止一段」。只用静态边框，不加动效。 */
function StackEdges() {
  return (
    <>
      <span
        aria-hidden
        className="absolute inset-x-3.5 bottom-1 h-5 rounded-b-[20px] border border-t-0 border-border bg-card/70"
      />
      <span
        aria-hidden
        className="absolute inset-x-7 bottom-0 h-5 rounded-b-[20px] border border-t-0 border-border bg-card/40"
      />
    </>
  );
}

function GroupParts({
  characterName,
  characterId,
  folder,
  lookup,
  onMove,
  onOpen,
  flashId,
}: {
  characterName: string;
  characterId: string;
  folder: FolderFilter;
  lookup: LobbySummaryLookup;
  onMove: (session: ChatSession) => void;
  onOpen: (sessionId: string) => void;
  flashId: string | null;
}) {
  const parts = useCharacterSessions(characterId, folder, true);
  return (
    <div
      role="group"
      aria-label={`${characterName} 的各段对话`}
      className="mb-1 ml-5 mt-2 space-y-2 border-l border-primary/25 pl-3"
    >
      {parts.isLoading ? (
        <p role="status" className="px-1 py-2 text-xs text-muted-foreground">
          正在读取各段对话…
        </p>
      ) : null}
      {parts.isError ? (
        <button
          type="button"
          onClick={() => void parts.refetch()}
          className="inline-flex min-h-11 items-center gap-1.5 px-1 text-xs text-primary"
        >
          <RefreshCw className="size-3.5" aria-hidden />
          读取失败，点此重试
        </button>
      ) : null}
      {parts.data?.sessions.map((session) => (
        <ConversationRow
          key={session.id}
          session={session}
          lookup={lookup}
          onMove={onMove}
          onOpen={onOpen}
          flash={flashId === session.id}
          nested
        />
      ))}
    </div>
  );
}
