'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, X } from 'lucide-react';

import { DEFAULT_LOBBY_SORT, type LobbySort } from '@miniapp/shared';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import {
  useCharactersQuery,
  useLobbyLatestBadgeQuery,
  useMarkLobbyLatestSeenMutation,
} from '@/lib/api/characters';
import { useBridgeStatus } from '@/lib/bridge';
import { getTimingMark } from '@/lib/bridge/iframe-timing';
import {
  beginCharacterNavigation,
  cancelBusinessNavigation,
} from '@/lib/sentry/business-navigation-telemetry';

import { CharacterCard, lobbyImageUrl } from './character-card';
import { CharacterDetailSheet } from './character-detail-sheet';

const FIRST_SCREEN_IMAGE_COUNT = 8;

const LOBBY_TABS: ReadonlyArray<{ value: LobbySort; label: string }> = [
  { value: 'recommended', label: '推荐' },
  { value: 'latest', label: '最新' },
];

// 命中打分:数字越大越精确,0 = 不命中
// 顺序:name 完整匹配 > name 开头 > name 包含 > tag 完整 > tag 包含 > author > description
function scoreMatch(
  c: { name: string; personality_tags: string[]; author_name: string; description: string },
  needle: string
): number {
  // 防御:任一字段在真后端可能为空 / undefined
  const name = (c.name ?? '').toLowerCase();
  const author = (c.author_name ?? '').toLowerCase();
  const desc = (c.description ?? '').toLowerCase();
  const tags = (c.personality_tags ?? []).map((t) => (t ?? '').toLowerCase());

  if (name && name === needle) return 100;
  if (name && name.startsWith(needle)) return 80;
  if (name && name.includes(needle)) return 60;
  if (tags.some((t) => t && t === needle)) return 50;
  if (tags.some((t) => t && t.includes(needle))) return 40;
  if (author && author.includes(needle)) return 30;
  if (desc && desc.includes(needle)) return 20;
  return 0;
}

export function CharacterGallery() {
  const router = useRouter();
  const bridgeStatus = useBridgeStatus();
  const [sort, setSort] = useState<LobbySort>(DEFAULT_LOBBY_SORT);
  const { data, isLoading, isError } = useCharactersQuery(sort);
  const [query, setQuery] = useState('');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [enteringId, setEnteringId] = useState<string | null>(null);
  const enteringRef = useRef(false);
  const businessAttemptIdRef = useRef<string>();

  const latestBadge = useLobbyLatestBadgeQuery();
  const { mutate: markLatestSeen } = useMarkLobbyLatestSeenMutation();
  const markedLatestRef = useRef(false);
  // 点「最新」当场收起，不等标记已看的请求回来；点推荐、搜索、卡片都不影响。
  const showLatestBadge = sort !== 'latest' && latestBadge.data?.has_new === true;

  // 进过「最新」就推进水位线，列表为空也算看过；每次挂载只写一次。
  useEffect(() => {
    if (sort !== 'latest' || markedLatestRef.current) return;
    markedLatestRef.current = true;
    markLatestSeen();
  }, [sort, markLatestSeen]);

  // 用户阅读角色详情时同步预取动态路由，减少点击进入后偶发等待路由资源的时间。
  useEffect(() => {
    if (previewId) router.prefetch(`/tavern/${previewId}`);
  }, [previewId, router]);

  const characters = useMemo(() => data?.characters ?? [], [data?.characters]);
  const firstScreenCharacters = useMemo(
    () => characters.slice(0, FIRST_SCREEN_IMAGE_COUNT),
    [characters]
  );

  useEffect(() => {
    if (firstScreenCharacters.length === 0) return;

    const preloadLinks: HTMLLinkElement[] = [];
    const connectedOrigins = new Set<string>();
    for (const character of firstScreenCharacters) {
      if (!character.avatar_url) continue;
      const href = lobbyImageUrl(character.avatar_url);
      try {
        const origin = new URL(href).origin;
        if (!connectedOrigins.has(origin)) {
          connectedOrigins.add(origin);
          const preconnect = document.createElement('link');
          preconnect.rel = 'preconnect';
          preconnect.href = origin;
          preconnect.crossOrigin = 'anonymous';
          document.head.append(preconnect);
          preloadLinks.push(preconnect);
        }
      } catch {
        // 相对 URL 无需额外 preconnect。
      }

      const preload = document.createElement('link');
      preload.rel = 'preload';
      preload.as = 'image';
      preload.href = href;
      preload.fetchPriority = 'high';
      document.head.append(preload);
      preloadLinks.push(preload);
    }

    return () => preloadLinks.forEach((link) => link.remove());
  }, [firstScreenCharacters]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return characters;
    return characters
      .map((c) => ({ c, s: scoreMatch(c, q) }))
      .filter(({ s }) => s > 0)
      .sort((a, b) => b.s - a.s)
      .map(({ c }) => c);
  }, [characters, query]);

  // 搜索框单独抽出,在 loading / 空态下也保持挂载,避免输入时焦点跳掉
  const searchBar = (
    <div className="mx-auto w-full max-w-screen-xl px-4 pb-2 pt-2 sm:px-6 lg:px-8">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索角色、标签或作者"
          className="h-10 rounded-full pl-10 pr-10 border-border bg-card text-foreground placeholder:text-muted-foreground/70 focus-visible:ring-ring/50 focus-visible:bg-secondary transition-all"
          aria-label="搜索角色"
        />
        {query && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setQuery('')}
            aria-label="清空搜索"
            className="absolute right-1 top-1 h-8 w-8 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );

  // 切换只改列表顺序，搜索词与卡片上的既有能力都保持不变。
  const sortTabs = (
    <div
      role="tablist"
      aria-label="角色排序"
      className="mx-auto flex w-full max-w-screen-xl items-center gap-2 px-4 pb-1 pt-1.5 sm:px-6 lg:px-8"
    >
      {LOBBY_TABS.map((tab) => {
        const active = sort === tab.value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setSort(tab.value)}
            className={cn(
              'relative rounded-full border px-4 py-1.5 text-[13px] transition-all',
              active
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'border-transparent text-muted-foreground hover:bg-card hover:text-foreground'
            )}
          >
            {tab.label}
            {/* 气泡浮在按钮右上角外侧，不压文字；pointer-events-none 保证点击区域完整。 */}
            {tab.value === 'latest' && showLatestBadge ? (
              <span
                role="status"
                aria-label="有新角色卡"
                className="pointer-events-none absolute -right-1 -top-1.5 rounded-full border border-success/50 bg-success/15 px-1.5 text-[9px] font-bold leading-[14px] tracking-wide text-success"
              >
                New
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );

  const listHeader = (
    <>
      {searchBar}
      {sortTabs}
    </>
  );

  if (isLoading) {
    return (
      <>
        {listHeader}
        <div
          className="mx-auto grid w-full max-w-screen-xl grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-3 px-4 py-6 sm:px-6 lg:px-8"
          aria-label="加载中"
        >
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="aspect-[3/4] w-full animate-breath rounded-[16px] bg-card border border-border"
            />
          ))}
        </div>
      </>
    );
  }

  if (isError) {
    return (
      <>
        {listHeader}
        <p className="mx-auto max-w-screen-xl px-4 py-8 text-center text-[13px] text-muted-foreground sm:px-6 lg:px-8">
          门好像被风合上了。稍后再来。
        </p>
      </>
    );
  }

  if (characters.length === 0) {
    return (
      <>
        {listHeader}
        <p className="mx-auto max-w-screen-xl px-4 py-8 text-center text-[13px] text-muted-foreground sm:px-6 lg:px-8">
          空旷的空间，还没有角色到达。
        </p>
      </>
    );
  }

  return (
    <>
      {listHeader}
      {filtered.length === 0 ? (
        <div className="mx-auto flex max-w-screen-xl flex-col items-center gap-2 px-4 py-10 sm:px-6 lg:px-8">
          <p className="text-center text-[13px] text-muted-foreground">没有匹配「{query}」的角色</p>
          <p className="text-center text-[11px] text-muted-foreground/80">
            可以到「创作」页右上角的许愿池告诉我们你想要的角色。
          </p>
        </div>
      ) : (
        <div className="mx-auto grid w-full max-w-screen-xl grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-3 px-4 pb-10 pt-2 sm:grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))] sm:gap-4 sm:px-6 lg:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] lg:px-8">
          {filtered.map((c, index) => (
            <CharacterCard
              key={c.id}
              character={c}
              priority={index < FIRST_SCREEN_IMAGE_COUNT}
              onSelect={() => {
                if (!enteringId) setPreviewId(c.id);
              }}
            />
          ))}
        </div>
      )}

      <CharacterDetailSheet
        characterId={previewId}
        entering={enteringId !== null}
        onClose={() => {
          if (enteringId) {
            cancelBusinessNavigation(businessAttemptIdRef.current, 'user_cancelled');
            enteringRef.current = false;
            setEnteringId(null);
            setPreviewId(null);
            // 当前本来就在大厅，直接 replace('/') 可能被 Next.js 当成同路由而忽略。
            // 唯一查询参数会启动一笔新的 SPA 导航，并让 App Router 放弃在途角色导航，
            // 同时保留 query cache、Telegram SDK 与 bridge 连接。
            router.replace(`/?entry_cancelled=${Date.now()}`);
            return;
          }
          setPreviewId(null);
        }}
        onEnter={(id) => {
          if (enteringRef.current) return;
          const bridgeStartedAt = getTimingMark('bridge_start');
          businessAttemptIdRef.current = beginCharacterNavigation(id, 'gallery', {
            pageFrom: '首页',
            navigationType: 'push',
            bridgePhase: bridgeStatus,
            ...(bridgeStartedAt ? { bootElapsedMs: Date.now() - bridgeStartedAt } : {}),
          });
          enteringRef.current = true;
          setEnteringId(id);
          router.push(`/tavern/${id}`);
        }}
      />
    </>
  );
}
