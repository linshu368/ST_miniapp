'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Heart, MessageCircle, RefreshCw } from 'lucide-react';

import type { ChatSession } from '@miniapp/shared';

import { cn } from '@/lib/utils';
import { useChatListStore } from '@/stores/chat-list';
import { useCharacterQuery } from '@/lib/api/characters';
import { useChatEngine } from '@/lib/api/chat-engine';
import { resolveSessionTitle, useConversationsQuery } from '@/lib/api/conversations';
import { useFavoritesQuery } from '@/lib/api/favorites';
import { FavoriteButton } from '@/components/characters/favorite-button';
import { lobbyImageUrl } from '@/components/characters/character-card';
import { useBridgeStatus } from '@/lib/bridge';
import { getTimingMark } from '@/lib/bridge/iframe-timing';
import { chatEntryPath } from '@/lib/chat-entry';
import { beginFirstChatNavigation } from '@/lib/sentry/first-chat-telemetry';

type ChatsTab = 'history' | 'favorites';

const TABS: { key: ChatsTab; label: string }[] = [
  { key: 'history', label: '历史聊天记录' },
  { key: 'favorites', label: '收藏角色卡' },
];

const TAB_COPY: Record<ChatsTab, { title: string; description: string }> = {
  history: {
    title: '历史聊天',
    description: '继续最近与角色的对话，上下文会完整保留。',
  },
  favorites: {
    title: '收藏角色卡',
    description: '你收藏的角色都在这里，点开即可继续聊天。',
  },
};

export default function ChatsPage() {
  const [tab, setTab] = useState<ChatsTab>('history');

  return (
    <main className="min-h-dvh bg-background px-4 pb-8 pt-[calc(1.5rem+env(safe-area-inset-top))] text-foreground">
      <header className="mx-auto mb-4 max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Messages</p>
        <h1 className="mt-1 text-2xl font-bold">{TAB_COPY[tab].title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{TAB_COPY[tab].description}</p>
      </header>

      <div
        className="mx-auto mb-5 flex max-w-2xl gap-1 rounded-full border border-border bg-card p-1"
        role="tablist"
        aria-label="对话与收藏"
      >
        {TABS.map((item) => {
          const active = item.key === tab;
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(item.key)}
              className={cn(
                'flex-1 rounded-full px-4 py-2 text-sm font-semibold transition-all active:scale-[0.98]',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {tab === 'history' ? <HistoryList /> : <FavoritesList />}
    </main>
  );
}

/**
 * 两条链路的历史来源不同：ST 走 chat 文件反代，自研链路直读 chat_sessions。
 * 开关解析出来之前谁都不查，猜错那次就是一发白打的 ST 反代请求。
 */
function HistoryList() {
  const { mode, resolved } = useChatEngine();

  if (!resolved) {
    return (
      <section className="mx-auto max-w-2xl space-y-2">
        <HistoryHint>正在读取历史对话…</HistoryHint>
      </section>
    );
  }

  return mode === 'self_hosted' ? <ConversationHistoryList /> : <StHistoryList />;
}

function StHistoryList() {
  const { items, loading, error, fetch } = useChatListStore();
  const bridgeStatus = useBridgeStatus();

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return (
    <section className="mx-auto max-w-2xl space-y-2">
      {loading && items.length === 0 ? <HistoryHint>正在读取历史对话…</HistoryHint> : null}

      {error ? <HistoryError onRetry={() => void fetch()} /> : null}

      {!loading && !error && items.length === 0 ? <HistoryEmpty /> : null}

      {items.map((item) => {
        if (!item.characterId) return null;
        return (
          <HistoryRow
            key={item.characterId}
            href={chatEntryPath('sillytavern', item.characterId, { legacyChatFile: item.fileName })}
            avatarUrl={item.characterAvatarUrl}
            name={item.characterName}
            timestamp={item.lastMessageAt}
            preview={item.lastMessage}
            onClick={() => recordFirstChatNavigation(item.characterId!, 'history', bridgeStatus)}
          />
        );
      })}
    </section>
  );
}

function ConversationHistoryList() {
  const { data, isLoading, isError, refetch } = useConversationsQuery(undefined);
  const sessions = data?.sessions ?? [];

  return (
    <section className="mx-auto max-w-2xl space-y-2">
      {isLoading && sessions.length === 0 ? <HistoryHint>正在读取历史对话…</HistoryHint> : null}

      {isError ? <HistoryError onRetry={() => void refetch()} /> : null}

      {!isLoading && !isError && sessions.length === 0 ? <HistoryEmpty /> : null}

      {sessions.map((session) => (
        <ConversationHistoryRow key={session.id} session={session} />
      ))}
    </section>
  );
}

/**
 * 会话列表只带 character_id。逐行取角色卡而不是让列表接口跟着长字段：
 * 同一角色的多个会话共用一份 query 缓存，一屏最多也就几张卡。
 */
function ConversationHistoryRow({ session }: { session: ChatSession }) {
  const { data } = useCharacterQuery(session.character_id);
  const character = data?.character;

  return (
    <HistoryRow
      href={chatEntryPath('self_hosted', session.character_id, { sessionId: session.id })}
      avatarUrl={character?.avatar_url ? lobbyImageUrl(character.avatar_url) : null}
      name={character?.name ?? resolveSessionTitle(session.title, session.last_message_preview)}
      timestamp={session.last_message_at ?? session.created_at}
      preview={session.last_message_preview}
    />
  );
}

function HistoryRow({
  href,
  avatarUrl,
  name,
  timestamp,
  preview,
  onClick,
}: {
  href: string;
  avatarUrl: string | null;
  name: string;
  timestamp: string;
  preview: string | null;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      onClick={onClick}
      className="flex items-center gap-3 rounded-3xl border border-border bg-card p-3.5 shadow-lg shadow-black/10 transition hover:border-primary/30 hover:bg-secondary active:scale-[0.99]"
    >
      <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-2xl bg-secondary">
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover object-top"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-primary">
            <MessageCircle className="h-5 w-5" />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-3">
          <span className="truncate font-semibold">{name}</span>
          <time className="shrink-0 text-[11px] text-muted-foreground">
            {formatActivityTime(timestamp)}
          </time>
        </span>
        <span className="mt-1 block truncate text-sm text-muted-foreground">
          {preview || '暂无消息摘要'}
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70" />
    </Link>
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
      <p className="text-sm text-destructive">历史聊天加载失败，请稍后重试。</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition active:scale-95"
      >
        <RefreshCw className="h-4 w-4" />
        重试
      </button>
    </div>
  );
}

function HistoryEmpty() {
  return (
    <div className="rounded-3xl border border-border bg-card p-8 text-center">
      <MessageCircle className="mx-auto h-9 w-9 text-primary" />
      <h2 className="mt-3 font-semibold">还没有有效对话</h2>
      <p className="mt-1 text-sm text-muted-foreground">与角色至少发送一句消息后会显示在这里。</p>
      <Link
        href="/"
        className="mt-4 inline-flex rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition active:scale-95"
      >
        去选择角色
      </Link>
    </div>
  );
}

function FavoritesList() {
  const { data, isLoading, isError, refetch } = useFavoritesQuery();
  const characters = data?.characters ?? [];
  const bridgeStatus = useBridgeStatus();
  const { mode: chatEngineMode } = useChatEngine();

  if (isLoading && characters.length === 0) {
    return (
      <section className="mx-auto max-w-2xl space-y-2">
        <div className="rounded-3xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          正在读取收藏…
        </div>
      </section>
    );
  }

  if (isError) {
    return (
      <section className="mx-auto max-w-2xl">
        <div className="rounded-3xl border border-destructive/30 bg-destructive/10 p-5">
          <p className="text-sm text-destructive">收藏列表加载失败，请稍后重试。</p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="mt-3 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition active:scale-95"
          >
            <RefreshCw className="h-4 w-4" />
            重试
          </button>
        </div>
      </section>
    );
  }

  if (characters.length === 0) {
    return (
      <section className="mx-auto max-w-2xl">
        <div className="rounded-3xl border border-border bg-card p-8 text-center">
          <Heart className="mx-auto h-9 w-9 text-rose" />
          <h2 className="mt-3 font-semibold">还没有收藏角色卡</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            在首页或角色详情里点心形，收藏的角色就会出现在这里。
          </p>
          <Link
            href="/"
            className="mt-4 inline-flex rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition active:scale-95"
          >
            去首页浏览角色
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-2xl space-y-2">
      {characters.map((character) => (
        // 整行可点进入聊天，心形浮在上层单独响应，避免 Link 里嵌 button。
        <div
          key={character.id}
          className="relative flex items-center gap-3 rounded-3xl border border-border bg-card p-3.5 shadow-lg shadow-black/10 transition hover:border-primary/30 hover:bg-secondary"
        >
          <Link
            href={chatEntryPath(chatEngineMode, character.id)}
            prefetch={false}
            onClick={() => {
              // ST 冷启动埋点在自研链路里没有收口点，切过去后不再开这段 span。
              if (chatEngineMode === 'self_hosted') return;
              recordFirstChatNavigation(character.id, 'favorites', bridgeStatus);
            }}
            aria-label={`进入 ${character.name} 的聊天`}
            className="absolute inset-0 rounded-3xl"
          />
          <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-2xl bg-secondary">
            {character.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={lobbyImageUrl(character.avatar_url)}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover object-top"
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-rose">
                <Heart className="h-5 w-5" />
              </span>
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{character.name}</span>
            <span className="mt-1 block truncate text-sm text-muted-foreground">
              {character.description?.trim() || '暂无角色简介'}
            </span>
          </span>
          <FavoriteButton characterId={character.id} variant="header" className="relative z-10" />
        </div>
      ))}
    </section>
  );
}

function recordFirstChatNavigation(
  characterId: string,
  source: 'history' | 'favorites',
  bridgePhase: string
): void {
  const bridgeStartedAt = getTimingMark('bridge_start');
  beginFirstChatNavigation(characterId, source, {
    bridgePhase,
    ...(bridgeStartedAt ? { bootElapsedMs: Date.now() - bridgeStartedAt } : {}),
  });
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
