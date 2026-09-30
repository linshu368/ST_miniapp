'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { chatEntryPath } from '@/lib/chat-entry';
import {
  clearLobbyReturnSnapshot,
  readLobbyReturnSnapshot,
  saveLobbyReturnSnapshot,
  type LobbyReturnSnapshot,
} from '@/lib/lobby-return';

import { CharacterCard, lobbyImageUrl } from './character-card';
import { CharacterDetailSheet } from './character-detail-sheet';

const FIRST_SCREEN_IMAGE_COUNT = 8;

const LOBBY_TABS: ReadonlyArray<{ value: LobbySort; label: string }> = [
  { value: 'recommended', label: '推荐' },
  { value: 'latest', label: '最新' },
];

const RESTORE_DEADLINE_MS = 1600;
const NEIGHBOR_WINDOW = 4;

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

function findLobbyCardElement(characterId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const cards = document.querySelectorAll<HTMLElement>('[data-lobby-character-id]');
  for (const card of cards) {
    if (card.dataset.lobbyCharacterId === characterId) return card;
  }
  return null;
}

function clampScrollY(scrollY: number): number {
  if (typeof window === 'undefined') return scrollY;
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  return Math.min(Math.max(0, scrollY), maxScroll);
}

function neighborIds(ids: string[], anchorId: string): string[] {
  const index = ids.indexOf(anchorId);
  if (index < 0) return [];
  const neighbors: string[] = [];
  for (let offset = 1; offset <= NEIGHBOR_WINDOW; offset += 1) {
    const before = ids[index - offset];
    const after = ids[index + offset];
    if (before) neighbors.push(before);
    if (after) neighbors.push(after);
  }
  return neighbors;
}

export function CharacterGallery() {
  const router = useRouter();
  const [restoreSnapshot] = useState<LobbyReturnSnapshot | null>(() => readLobbyReturnSnapshot());
  const [isRestoring, setIsRestoring] = useState(() => restoreSnapshot !== null);
  const [sort, setSort] = useState<LobbySort>(restoreSnapshot?.sort ?? DEFAULT_LOBBY_SORT);
  const { data, isLoading, isError } = useCharactersQuery(sort, {
    skipMountRefetch: isRestoring,
  });
  const [query, setQuery] = useState(restoreSnapshot?.query ?? '');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [enteringId, setEnteringId] = useState<string | null>(null);
  const enteringRef = useRef(false);
  const restoredAnchorIdRef = useRef<string | null>(null);
  const restoreCalibrationUsedRef = useRef(false);

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
    if (previewId) router.prefetch(chatEntryPath(previewId));
  }, [previewId, router]);

  const characters = useMemo(() => data?.characters ?? [], [data?.characters]);
  const firstScreenCharacters = useMemo(
    () => characters.slice(0, FIRST_SCREEN_IMAGE_COUNT),
    [characters]
  );

  useEffect(() => {
    if (!restoreSnapshot) return;
    // 快照读入组件 state 后即可清掉共享存储；后续恢复只依赖本次挂载持有的副本，
    // 避免弱网等待期间旧快照被其他入口误复用。
    clearLobbyReturnSnapshot();
  }, [restoreSnapshot]);

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

  const finishRestore = useCallback(() => {
    clearLobbyReturnSnapshot();
    setIsRestoring(false);
  }, []);

  const restoreFromSnapshot = useCallback(
    (allowScrollFallback: boolean): boolean => {
      if (!restoreSnapshot || typeof window === 'undefined') return false;

      const candidateIds = [
        restoreSnapshot.anchorCharacterId,
        ...restoreSnapshot.neighborCharacterIds,
      ];
      for (const id of candidateIds) {
        const element = findLobbyCardElement(id);
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        window.scrollTo({
          top: clampScrollY(window.scrollY + rect.top - restoreSnapshot.anchorViewportTop),
          left: 0,
          behavior: 'auto',
        });
        restoredAnchorIdRef.current = id;
        finishRestore();
        return true;
      }

      if (allowScrollFallback || filtered.length > 0 || isError) {
        window.scrollTo({ top: clampScrollY(restoreSnapshot.scrollY), left: 0, behavior: 'auto' });
        finishRestore();
        return true;
      }

      return false;
    },
    [filtered.length, finishRestore, isError, restoreSnapshot]
  );

  useLayoutEffect(() => {
    if (!isRestoring || isLoading) return;
    restoreFromSnapshot(false);
  }, [isLoading, isRestoring, restoreFromSnapshot]);

  useEffect(() => {
    if (!isRestoring) return;
    const timer = window.setTimeout(() => {
      restoreFromSnapshot(true);
    }, RESTORE_DEADLINE_MS);
    return () => window.clearTimeout(timer);
  }, [isRestoring, restoreFromSnapshot]);

  const cancelRestore = useCallback(() => {
    if (!isRestoring) return;
    finishRestore();
  }, [finishRestore, isRestoring]);

  const captureReturnSnapshot = useCallback(
    (characterId: string) => {
      if (typeof window === 'undefined') return;
      const loadedCharacterIds = filtered.map((character) => character.id);
      const element = findLobbyCardElement(characterId);
      const rect = element?.getBoundingClientRect();
      saveLobbyReturnSnapshot({
        sort,
        query,
        anchorCharacterId: characterId,
        neighborCharacterIds: neighborIds(loadedCharacterIds, characterId),
        loadedCharacterIds,
        anchorViewportTop: rect?.top ?? 0,
        scrollY: window.scrollY,
        viewportWidth: window.innerWidth,
      });
    },
    [filtered, query, sort]
  );

  const handleImageSettled = useCallback(
    (characterId: string) => {
      if (
        restoreCalibrationUsedRef.current ||
        restoredAnchorIdRef.current !== characterId ||
        !restoreSnapshot
      ) {
        return;
      }
      restoreCalibrationUsedRef.current = true;
      window.requestAnimationFrame(() => {
        const element = findLobbyCardElement(characterId);
        if (!element) return;
        const rect = element.getBoundingClientRect();
        window.scrollTo({
          top: clampScrollY(window.scrollY + rect.top - restoreSnapshot.anchorViewportTop),
          left: 0,
          behavior: 'auto',
        });
      });
    },
    [restoreSnapshot]
  );

  const hiddenWhileRestoring = isRestoring ? 'invisible' : undefined;

  // 搜索框单独抽出,在 loading / 空态下也保持挂载,避免输入时焦点跳掉
  const searchBar = (
    <div
      className={cn(
        'mx-auto w-full max-w-screen-xl px-4 pb-2 pt-2 sm:px-6 lg:px-8',
        hiddenWhileRestoring
      )}
    >
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="text"
          value={query}
          onChange={(e) => {
            cancelRestore();
            setQuery(e.target.value);
          }}
          placeholder="搜索角色、标签或作者"
          className="h-10 rounded-full pl-10 pr-10 border-border bg-card text-foreground placeholder:text-muted-foreground/70 focus-visible:ring-ring/50 focus-visible:bg-secondary transition-all"
          aria-label="搜索角色"
        />
        {query && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              cancelRestore();
              setQuery('');
            }}
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
      className={cn(
        'mx-auto flex w-full max-w-screen-xl items-center gap-2 px-4 pb-1 pt-1.5 sm:px-6 lg:px-8',
        hiddenWhileRestoring
      )}
    >
      {LOBBY_TABS.map((tab) => {
        const active = sort === tab.value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => {
              if (sort !== tab.value) cancelRestore();
              setSort(tab.value);
            }}
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
          className={cn(
            'mx-auto grid w-full max-w-screen-xl grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-3 px-4 py-6 sm:px-6 lg:px-8',
            hiddenWhileRestoring
          )}
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
        <p
          className={cn(
            'mx-auto max-w-screen-xl px-4 py-8 text-center text-[13px] text-muted-foreground sm:px-6 lg:px-8',
            hiddenWhileRestoring
          )}
        >
          门好像被风合上了。稍后再来。
        </p>
      </>
    );
  }

  if (characters.length === 0) {
    return (
      <>
        {listHeader}
        <p
          className={cn(
            'mx-auto max-w-screen-xl px-4 py-8 text-center text-[13px] text-muted-foreground sm:px-6 lg:px-8',
            hiddenWhileRestoring
          )}
        >
          空旷的空间，还没有角色到达。
        </p>
      </>
    );
  }

  return (
    <>
      {listHeader}
      {filtered.length === 0 ? (
        <div
          className={cn(
            'mx-auto flex max-w-screen-xl flex-col items-center gap-2 px-4 py-10 sm:px-6 lg:px-8',
            hiddenWhileRestoring
          )}
        >
          <p className="text-center text-[13px] text-muted-foreground">没有匹配「{query}」的角色</p>
          <p className="text-center text-[11px] text-muted-foreground/80">
            可以到「创作」页右上角的许愿池告诉我们你想要的角色。
          </p>
        </div>
      ) : (
        <div
          className={cn(
            'mx-auto grid w-full max-w-screen-xl grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-3 px-4 pb-10 pt-2 sm:grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))] sm:gap-4 sm:px-6 lg:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] lg:px-8',
            hiddenWhileRestoring
          )}
        >
          {filtered.map((c, index) => (
            <CharacterCard
              key={c.id}
              character={c}
              priority={index < FIRST_SCREEN_IMAGE_COUNT}
              onImageSettled={handleImageSettled}
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
            enteringRef.current = false;
            setEnteringId(null);
            setPreviewId(null);
            clearLobbyReturnSnapshot();
            // 当前本来就在大厅，直接 replace('/') 可能被 Next.js 当成同路由而忽略。
            // 唯一查询参数会启动一笔新的 SPA 导航，并让 App Router 放弃在途角色导航，
            // 同时保留 query cache 与 Telegram SDK。
            router.replace(`/?entry_cancelled=${Date.now()}`);
            return;
          }
          setPreviewId(null);
        }}
        onEnter={(id) => {
          if (enteringRef.current) return;
          enteringRef.current = true;
          captureReturnSnapshot(id);
          setEnteringId(id);
          router.push(chatEntryPath(id));
        }}
      />
    </>
  );
}
