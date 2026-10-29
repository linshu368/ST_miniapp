'use client';

import Link from 'next/link';
import { ChevronRight, MessageCircle, RefreshCw } from 'lucide-react';
import type { CharacterSummary, ChatSession } from '@miniapp/shared';

import { lobbyImageUrl } from '@/components/characters/character-card';
import { resolveSessionTitle } from '@/lib/api/conversations';
import { chatEntryPath } from '@/lib/chat-entry';
import { rememberRoleplayScroll, rememberRoleplayView } from '@/lib/roleplay-navigation';

interface RecentConversationCardProps {
  enabled: boolean;
  recent: ChatSession | undefined;
  character: CharacterSummary | undefined;
  loading: boolean;
  error: boolean;
  fetching: boolean;
  onRetry: () => void;
}

export function RecentConversationCard({
  enabled,
  recent,
  character,
  loading,
  error,
  fetching,
  onRetry,
}: RecentConversationCardProps) {
  // 会话列表与角色摘要都由 Gallery 的唯一订阅下传；这里保持纯展示，避免同页
  // 再挂 query observer 或为列表里已有角色补打一条详情请求。
  if (!enabled) return null;

  if (loading && !recent) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 pb-2" role="status">
        <p className="rounded-2xl border border-border/60 bg-card/50 px-4 py-3 text-xs text-muted-foreground">
          正在读取可继续的对话…
        </p>
      </div>
    );
  }

  if (error && !recent) {
    return (
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-3 px-4 pb-2">
        <p className="text-xs text-muted-foreground">暂时没能读取上次对话</p>
        <button
          type="button"
          disabled={fetching}
          onClick={onRetry}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-xs text-primary disabled:opacity-50"
        >
          <RefreshCw className="size-3.5" aria-hidden />
          重试
        </button>
      </div>
    );
  }

  if (!recent) return null;

  const title = resolveSessionTitle(recent.title, character?.name ?? '对话');
  const avatarUrl = character?.avatar_url ? lobbyImageUrl(character.avatar_url) : null;

  return (
    <section aria-label="继续对话" className="mx-auto w-full max-w-2xl px-4 pb-3 pt-1">
      <Link
        href={chatEntryPath(recent.character_id, { sessionId: recent.id, source: 'discover' })}
        prefetch={false}
        onClick={() => {
          rememberRoleplayView('/characters');
          rememberRoleplayScroll('/characters');
        }}
        aria-label={`接着聊：${title}`}
        className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card/50 px-3 py-3 transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-secondary text-primary">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt=""
              loading="lazy"
              className="size-full object-cover object-top"
            />
          ) : (
            <MessageCircle className="size-4" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[10px] font-medium text-muted-foreground">接着聊</h2>
            <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-primary">
              继续聊
              <ChevronRight className="size-3" aria-hidden />
            </span>
          </div>
          <p className="truncate text-[13px] font-semibold text-foreground">{title}</p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {recent.last_message_preview || character?.name || '继续这段对话'}
          </p>
        </div>
      </Link>
    </section>
  );
}
