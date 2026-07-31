'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Heart, MessageCircle, RefreshCw } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useChatListStore } from '@/stores/chat-list';
import { useFavoritesQuery } from '@/lib/api/favorites';
import { FavoriteButton } from '@/components/characters/favorite-button';
import { lobbyImageUrl } from '@/components/characters/character-card';
import { useBridgeStatus } from '@/lib/bridge';
import { getTimingMark } from '@/lib/bridge/iframe-timing';
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
    <main className="min-h-dvh bg-[#0e0918] px-4 pb-8 pt-[calc(1.5rem+env(safe-area-inset-top))] text-white">
      <header className="mx-auto mb-4 max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#ef856d]">Messages</p>
        <h1 className="mt-1 text-2xl font-bold">{TAB_COPY[tab].title}</h1>
        <p className="mt-1 text-sm text-white/55">{TAB_COPY[tab].description}</p>
      </header>

      <div
        className="mx-auto mb-5 flex max-w-2xl gap-1 rounded-full border border-white/10 bg-white/[0.05] p-1"
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
                active ? 'bg-[#ef856d] text-[#24111a]' : 'text-white/60 hover:text-white/85'
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

function HistoryList() {
  const { items, loading, error, fetch } = useChatListStore();
  const bridgeStatus = useBridgeStatus();

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return (
    <section className="mx-auto max-w-2xl space-y-2">
      {loading && items.length === 0 ? (
        <div className="rounded-3xl border border-white/10 bg-white/[0.05] p-8 text-center text-sm text-white/55">
          正在读取历史对话…
        </div>
      ) : null}

      {error ? (
        <div className="rounded-3xl border border-red-400/25 bg-red-400/[0.07] p-5">
          <p className="text-sm text-red-200">历史聊天加载失败，请稍后重试。</p>
          <button
            type="button"
            onClick={() => void fetch()}
            className="mt-3 inline-flex items-center gap-2 rounded-full bg-[#ef856d] px-4 py-2 text-sm font-semibold text-[#24111a] transition active:scale-95"
          >
            <RefreshCw className="h-4 w-4" />
            重试
          </button>
        </div>
      ) : null}

      {!loading && !error && items.length === 0 ? (
        <div className="rounded-3xl border border-white/10 bg-white/[0.05] p-8 text-center">
          <MessageCircle className="mx-auto h-9 w-9 text-[#ef856d]" />
          <h2 className="mt-3 font-semibold">还没有有效对话</h2>
          <p className="mt-1 text-sm text-white/55">与角色至少发送一句消息后会显示在这里。</p>
          <Link
            href="/"
            className="mt-4 inline-flex rounded-full bg-[#ef856d] px-5 py-2.5 text-sm font-semibold text-[#24111a] transition active:scale-95"
          >
            去选择角色
          </Link>
        </div>
      ) : null}

      {items.map((item) => {
        if (!item.characterId) return null;
        const search = new URLSearchParams({ chat: item.fileName });
        return (
          <Link
            key={item.characterId}
            href={`/tavern/${item.characterId}?${search.toString()}`}
            prefetch={false}
            onClick={() => recordFirstChatNavigation(item.characterId!, 'history', bridgeStatus)}
            className="flex items-center gap-3 rounded-3xl border border-white/10 bg-white/[0.05] p-3.5 shadow-lg shadow-black/10 transition hover:border-white/20 hover:bg-white/[0.075] active:scale-[0.99]"
          >
            <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-2xl bg-white/10">
              {item.characterAvatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.characterAvatarUrl}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover object-top"
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-[#ef856d]">
                  <MessageCircle className="h-5 w-5" />
                </span>
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-3">
                <span className="truncate font-semibold">{item.characterName}</span>
                <time className="shrink-0 text-[11px] text-white/45">
                  {formatActivityTime(item.lastMessageAt)}
                </time>
              </span>
              <span className="mt-1 block truncate text-sm text-white/55">
                {item.lastMessage || '暂无消息摘要'}
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-white/35" />
          </Link>
        );
      })}
    </section>
  );
}

function FavoritesList() {
  const { data, isLoading, isError, refetch } = useFavoritesQuery();
  const characters = data?.characters ?? [];
  const bridgeStatus = useBridgeStatus();

  if (isLoading && characters.length === 0) {
    return (
      <section className="mx-auto max-w-2xl space-y-2">
        <div className="rounded-3xl border border-white/10 bg-white/[0.05] p-8 text-center text-sm text-white/55">
          正在读取收藏…
        </div>
      </section>
    );
  }

  if (isError) {
    return (
      <section className="mx-auto max-w-2xl">
        <div className="rounded-3xl border border-red-400/25 bg-red-400/[0.07] p-5">
          <p className="text-sm text-red-200">收藏列表加载失败，请稍后重试。</p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="mt-3 inline-flex items-center gap-2 rounded-full bg-[#ef856d] px-4 py-2 text-sm font-semibold text-[#24111a] transition active:scale-95"
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
        <div className="rounded-3xl border border-white/10 bg-white/[0.05] p-8 text-center">
          <Heart className="mx-auto h-9 w-9 text-[#ef856d]" />
          <h2 className="mt-3 font-semibold">还没有收藏角色卡</h2>
          <p className="mt-1 text-sm text-white/55">
            在首页或角色详情里点心形，收藏的角色就会出现在这里。
          </p>
          <Link
            href="/"
            className="mt-4 inline-flex rounded-full bg-[#ef856d] px-5 py-2.5 text-sm font-semibold text-[#24111a] transition active:scale-95"
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
          className="relative flex items-center gap-3 rounded-3xl border border-white/10 bg-white/[0.05] p-3.5 shadow-lg shadow-black/10 transition hover:border-white/20 hover:bg-white/[0.075]"
        >
          <Link
            href={`/tavern/${character.id}`}
            prefetch={false}
            onClick={() => recordFirstChatNavigation(character.id, 'favorites', bridgeStatus)}
            aria-label={`进入 ${character.name} 的聊天`}
            className="absolute inset-0 rounded-3xl"
          />
          <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-2xl bg-white/10">
            {character.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={lobbyImageUrl(character.avatar_url)}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover object-top"
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-[#ef856d]">
                <Heart className="h-5 w-5" />
              </span>
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{character.name}</span>
            <span className="mt-1 block truncate text-sm text-white/55">
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
