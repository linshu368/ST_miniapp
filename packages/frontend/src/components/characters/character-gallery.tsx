'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Heart, Search, X } from 'lucide-react';

import { DEFAULT_LOBBY_SORT, type LobbySort } from '@miniapp/shared';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import {
  useCharactersQuery,
  useLobbyLatestBadgeQuery,
  useMarkLobbyLatestSeenMutation,
} from '@/lib/api/characters';
import { markCriticalSettled, useEntryEnrichReady } from '@/lib/entry-phase';
import { chatEntryPath } from '@/lib/chat-entry';
import { useFavoriteIdsQuery } from '@/lib/api/favorites';
import { useConversationsQuery } from '@/lib/api/conversations';
import {
  readRoleplayDiscovery,
  rememberRoleplayDiscovery,
  rememberRoleplayScroll,
  restoreRoleplayScroll,
} from '@/lib/roleplay-navigation';
import { discardPendingAction, startPendingAction } from '@/lib/perf/action-tracker';
import { useFreshAfterFetch, usePageReady } from '@/lib/perf/page-ready';
import {
  clearLobbyReturnSnapshot,
  readLobbyReturnSnapshot,
  saveLobbyReturnSnapshot,
  type LobbyReturnSnapshot,
} from '@/lib/lobby-return';

import { CharacterCard, lobbyImageUrl } from './character-card';
import { CharacterDetailSheet } from './character-detail-sheet';
import { RoleplayHeader } from '@/components/roleplay/roleplay-header';
import { RecentConversationCard } from '@/components/roleplay/recent-conversation-card';

// 移动端两列首屏实际可见约 4–6 张；高优先级给多了会和 LCP 图抢带宽。
const FIRST_SCREEN_IMAGE_COUNT = 6;

const LOBBY_TABS: ReadonlyArray<{ value: LobbySort; label: string }> = [
  { value: 'recommended', label: '推荐' },
  { value: 'latest', label: '最新' },
];

// 首帧只挂这么多张卡，其余滚动到接近底部时再分批补齐：每张卡带图片、收藏订阅和金框，
// 一次挂几十张会让底部 tab 切回大厅时主线程被占满、转场掉帧。
const INITIAL_RENDER_COUNT = 10;
const RENDER_BATCH_SIZE = 10;
// 哨兵提前多远触发下一批；留足一屏以上，用户正常滚动时不会看到空白。
const RENDER_MORE_ROOT_MARGIN = '400px';
// 返回大厅时锚点之后额外挂的卡数：两列约 4 行再留余量，其余随滚动补齐。
const RESTORE_TAIL_COUNT = 12;

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
  const [savedDiscovery] = useState(readRoleplayDiscovery);
  // P0=列表；enrich=收藏/会话史/角标。列表有缓存或首包结算后 markCriticalSettled。
  const enrichReady = useEntryEnrichReady();
  const favoriteIds = useFavoriteIdsQuery({ enabled: enrichReady });
  const history = useConversationsQuery(undefined, enrichReady);
  // message_count 不计虚拟开场白；只标记已确认的用户对话，未命中不代表从未聊过。
  const experiencedIds = useMemo(
    () =>
      new Set(
        (history.data?.sessions ?? [])
          .filter((item) => item.message_count > 0)
          .map((item) => item.character_id)
      ),
    [history.data?.sessions]
  );
  const [restoreSnapshot] = useState<LobbyReturnSnapshot | null>(() => readLobbyReturnSnapshot());
  const [isRestoring, setIsRestoring] = useState(() => restoreSnapshot !== null);
  const [sort, setSort] = useState<LobbySort>(
    restoreSnapshot?.sort ?? savedDiscovery.sort ?? DEFAULT_LOBBY_SORT
  );
  const { data, isLoading, isError, isFetching, isFetched } = useCharactersQuery(sort, {
    skipMountRefetch: isRestoring,
  });
  // 有可展示数据（含本地缓存）或列表已失败/完成首轮，即放行 enrich，别让旁路永远等。
  useEffect(() => {
    if (data !== undefined || isError || isFetched) markCriticalSettled();
  }, [data, isError, isFetched]);
  // 大厅有本地缓存秒开：content 记用户看到列表的时刻，fresh 记最新列表到达的时刻，两者分开才看得出后端慢。
  const lobbyFresh = useFreshAfterFetch(isFetching, data !== undefined);
  usePageReady('/', data !== undefined, lobbyFresh);
  const [query, setQuery] = useState(restoreSnapshot?.query ?? savedDiscovery.query);
  const [favoritesOnly, setFavoritesOnly] = useState(
    restoreSnapshot?.favoritesOnly ?? savedDiscovery.favoritesOnly
  );
  const generalScrollRestored = useRef(false);
  useEffect(() => {
    rememberRoleplayDiscovery({ sort, query, favoritesOnly });
  }, [sort, query, favoritesOnly]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [enteringId, setEnteringId] = useState<string | null>(null);
  const enteringRef = useRef(false);
  const restoredAnchorIdRef = useRef<string | null>(null);
  const restoreCalibrationUsedRef = useRef(false);

  const latestBadge = useLobbyLatestBadgeQuery({ enabled: enrichReady });
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

  // 弹层用列表里已有的摘要即时打开，详情接口只补开场白。
  const previewSummary = useMemo(
    () => (previewId ? characters.find((c) => c.id === previewId) : undefined),
    [characters, previewId]
  );

  // 引用必须稳定，CharacterCard 的 memo 才有意义：打开弹层不再重渲染整页卡片。
  const handleSelectCharacter = useCallback(
    (id: string) => {
      if (!enteringId) setPreviewId(id);
    },
    [enteringId]
  );

  // 弹层盖住大厅期间暂停底下所有金框流光（弹层自己的金框不受影响，见 globals.css）。
  useEffect(() => {
    if (!previewId) return;
    const root = document.documentElement;
    root.classList.add('featured-paused');
    return () => root.classList.remove('featured-paused');
  }, [previewId]);
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
    const ids = new Set(favoriteIds.data?.character_ids ?? []);
    const source = favoritesOnly
      ? characters.filter((character) => ids.has(character.id))
      : characters;
    if (!q) return source;
    return source
      .map((c) => ({ c, s: scoreMatch(c, q) }))
      .filter(({ s }) => s > 0)
      .sort((a, b) => b.s - a.s)
      .map(({ c }) => c);
  }, [characters, query, favoritesOnly, favoriteIds.data]);

  useLayoutEffect(() => {
    if (
      generalScrollRestored.current ||
      restoreSnapshot ||
      !data ||
      (favoritesOnly && favoriteIds.isPending)
    )
      return;
    generalScrollRestored.current = true;
    restoreRoleplayScroll('/');
  }, [data, restoreSnapshot, favoritesOnly, favoriteIds.isPending]);

  const [renderLimit, setRenderLimit] = useState(INITIAL_RENDER_COUNT);
  // 从详情返回靠锚点卡片还原滚动位置：锚点及其之前的卡必须已挂载，之后只需再多挂约一屏。
  // 不能整表一次挂全：整页在 invisible 状态下同步挂几十上百张卡，返回时就是“闪一下再卡一下”。
  // 该值只依赖挂载时持有的快照，恢复结束后不会回落，避免已显示的卡被卸载。
  const restoreFloor = useMemo(() => {
    if (!restoreSnapshot) return 0;
    const candidateIds = [
      restoreSnapshot.anchorCharacterId,
      ...restoreSnapshot.neighborCharacterIds,
    ];
    for (const id of candidateIds) {
      const index = filtered.findIndex((c) => c.id === id);
      if (index >= 0) return index + RESTORE_TAIL_COUNT;
    }
    // 锚点和邻居都不在当前列表里（数据已变）：走 scrollY 兜底，需要足够高度，只能全量。
    return filtered.length > 0 ? Number.POSITIVE_INFINITY : 0;
  }, [filtered, restoreSnapshot]);
  const effectiveLimit = Math.max(renderLimit, restoreFloor);
  // 搜索时结果通常很少且用户在等结果，直接全量，不让命中的卡被分批延迟。
  const renderAll = query.trim() !== '';
  const visibleCharacters = useMemo(
    () => (renderAll ? filtered : filtered.slice(0, effectiveLimit)),
    [filtered, renderAll, effectiveLimit]
  );

  // 按滚动位置补齐，而不是在空闲帧定时补：定时补会在路由 transition 渲染让出主线程的间隙里
  // 触发默认优先级的 setState，同步挂一批卡并打断导航，表现为底部 tab 高亮已变但页面不跳转。
  // 哨兵只在用户接近列表底部时才触发；每批挂完 effectiveLimit 变化会重建观察器，
  // 哨兵仍在范围内就继续补，直到它被推到范围之外。
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const hasMoreToRender = !renderAll && effectiveLimit < filtered.length;
  useEffect(() => {
    const node = loadMoreRef.current;
    if (!hasMoreToRender || !node) return;
    const grow = () => setRenderLimit((limit) => Math.max(limit, restoreFloor) + RENDER_BATCH_SIZE);
    if (typeof IntersectionObserver === 'undefined') {
      // 极老的 WebView 没有观察器：退回一次性全量，保证列表完整。
      setRenderLimit(Number.POSITIVE_INFINITY);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) grow();
      },
      { rootMargin: RENDER_MORE_ROOT_MARGIN }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMoreToRender, effectiveLimit, restoreFloor]);

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
        favoritesOnly,
        anchorCharacterId: characterId,
        neighborCharacterIds: neighborIds(loadedCharacterIds, characterId),
        loadedCharacterIds,
        anchorViewportTop: rect?.top ?? 0,
        scrollY: window.scrollY,
        viewportWidth: window.innerWidth,
      });
    },
    [filtered, query, sort, favoritesOnly]
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
        const active = !favoritesOnly && sort === tab.value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => {
              if (sort !== tab.value) cancelRestore();
              setFavoritesOnly(false);
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
      <button
        type="button"
        role="tab"
        aria-selected={favoritesOnly}
        onClick={() => {
          cancelRestore();
          setFavoritesOnly(true);
        }}
        className={cn(
          'flex min-h-10 items-center gap-1.5 rounded-full border px-4 py-1.5 text-[13px] transition-colors',
          favoritesOnly
            ? 'border-primary/30 bg-primary/10 text-primary'
            : 'border-transparent text-muted-foreground hover:bg-card hover:text-foreground'
        )}
      >
        <Heart className="size-3.5" aria-hidden />
        已收藏
      </button>
    </div>
  );

  const listHeader = (
    <>
      <RoleplayHeader active="discover">
        {searchBar}
        {sortTabs}
      </RoleplayHeader>
      <RecentConversationCard />
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
      {favoritesOnly && favoriteIds.isPending ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground" role="status">
          正在读取收藏…
        </p>
      ) : favoritesOnly && favoriteIds.isError ? (
        <div className="px-4 py-10 text-center">
          <p className="text-sm text-muted-foreground">收藏暂时没加载出来</p>
          <button
            type="button"
            onClick={() => void favoriteIds.refetch()}
            className="mt-3 min-h-10 rounded-full bg-secondary px-5 text-sm"
          >
            重新加载
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div
          className={cn(
            'mx-auto flex max-w-screen-xl flex-col items-center gap-2 px-4 py-10 sm:px-6 lg:px-8',
            hiddenWhileRestoring
          )}
        >
          <p className="text-center text-[13px] text-muted-foreground">
            {favoritesOnly && !query.trim() ? '还没有收藏的角色' : `没有匹配「${query}」的角色`}
          </p>
          <p className="text-center text-[11px] text-muted-foreground/80">
            {favoritesOnly
              ? '遇到喜欢的角色，点一下心形就能留在这里。'
              : '换个名字或标签试试，也可以看看推荐角色。'}
          </p>
        </div>
      ) : (
        <div
          className={cn(
            'mx-auto grid w-full max-w-screen-xl grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-3 px-4 pb-10 pt-2 sm:grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))] sm:gap-4 sm:px-6 lg:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] lg:px-8',
            hiddenWhileRestoring
          )}
        >
          {visibleCharacters.map((c, index) => (
            <CharacterCard
              key={c.id}
              character={c}
              experienced={experiencedIds.has(c.id)}
              priority={index < FIRST_SCREEN_IMAGE_COUNT}
              onImageSettled={handleImageSettled}
              onSelect={handleSelectCharacter}
            />
          ))}
        </div>
      )}
      {/* 渲染哨兵放在网格外：恢复滚动期间网格带 invisible，哨兵不受影响。 */}
      {hasMoreToRender ? (
        <div ref={loadMoreRef} aria-hidden="true" className="h-px w-full" />
      ) : null}

      <CharacterDetailSheet
        characterId={previewId}
        summary={previewSummary}
        entering={enteringId !== null}
        onClose={() => {
          if (enteringId) {
            enteringRef.current = false;
            setEnteringId(null);
            setPreviewId(null);
            clearLobbyReturnSnapshot();
            // 用户主动取消进入，不是卡住；不清掉的话 2.5 秒后看门狗会补发一条假的 action_stall。
            discardPendingAction('select_character');
            // 当前本来就在大厅，直接 replace('/') 可能被 Next.js 当成同路由而忽略。
            // 唯一查询参数会启动一笔新的 SPA 导航，并让 App Router 放弃在途角色导航，
            // 同时保留 query cache 与 Telegram SDK。
            router.replace(`/?entry_cancelled=${Date.now()}`);
            return;
          }
          setPreviewId(null);
        }}
        onEnter={(id, sessionId) => {
          if (enteringRef.current) return;
          enteringRef.current = true;
          captureReturnSnapshot(id);
          setEnteringId(id);
          startPendingAction('select_character');
          rememberRoleplayScroll('/');
          router.push(chatEntryPath(id, { sessionId, source: 'discover' }));
        }}
      />
    </>
  );
}
