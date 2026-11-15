'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { RefreshCw, Search, Sparkles, Undo2, X } from 'lucide-react';

import type { LobbySort } from '@miniapp/shared';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import { useLobbyLatestBadgeQuery, useMarkLobbyLatestSeenMutation } from '@/lib/api/characters';
import { useLobbyDiscoveryFeed } from '@/lib/api/lobby-recommendations';
import { lobbyViewerScope } from '@/lib/lobby-recommendation-state';
import { markCriticalSettled, useEntryEnrichReady } from '@/lib/entry-phase';
import { chatEntryPath } from '@/lib/chat-entry';
import { useCharacterSocialsQuery } from '@/lib/api/character-social';
import { useConversationsQuery } from '@/lib/api/conversations';
import {
  readRoleplayDiscovery,
  rememberRoleplayDiscovery,
  rememberRoleplayScroll,
  restoreRoleplayScroll,
} from '@/lib/roleplay-navigation';
import { discardPendingAction, startPendingAction } from '@/lib/perf/action-tracker';
import { useFreshAfterFetch, usePageReady } from '@/lib/perf/page-ready';
import { markPageCriticalVisual } from '@/lib/perf/page-tracker';
import { useMobilePerformancePolicy } from '@/lib/mobile-performance';
import {
  clearLobbyReturnSnapshot,
  readLobbyReturnSnapshot,
  saveLobbyReturnSnapshot,
  type LobbyReturnSnapshot,
} from '@/lib/lobby-return';

import { CharacterCard } from './character-card';
import { useLobbyExposures } from './use-lobby-exposures';
import type { CharacterDetailTab } from './character-detail-sheet';
import { RoleplayHeader } from '@/components/roleplay/roleplay-header';

const CharacterDetailSheet = dynamic(
  () =>
    import('./character-detail-sheet').then((module) => ({
      default: module.CharacterDetailSheet,
    })),
  { ssr: false }
);

const LOBBY_TABS: ReadonlyArray<{ value: LobbySort; label: string }> = [
  { value: 'recommended', label: '推荐' },
  { value: 'latest', label: '最新' },
];

// 首帧只挂这么多张卡，其余滚动到接近底部时再分批补齐：每张卡带图片、收藏订阅和金框，
// 一次挂几十张会让底部 tab 切回大厅时主线程被占满、转场掉帧。
// 返回大厅时锚点之后额外挂的卡数：两列约 4 行再留余量，其余随滚动补齐。
const RESTORE_TAIL_COUNT = 12;

const RESTORE_DEADLINE_MS = 1600;
const NEIGHBOR_WINDOW = 4;
const CACHE_REVALIDATE_FALLBACK_MS = {
  android: 3000,
  ios: 2500,
  other: 1500,
} as const;

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

function experiencedCharacterIds(
  sessions: readonly { message_count: number; character_id: string }[]
) {
  return new Set(
    sessions.filter((item) => item.message_count > 0).map((item) => item.character_id)
  );
}

export function CharacterGallery() {
  return <CharacterGalleryView key={lobbyViewerScope()} />;
}

function CharacterGalleryView() {
  const router = useRouter();
  const performancePolicy = useMobilePerformancePolicy();
  const listBudget = performancePolicy.characters;
  const [savedDiscovery] = useState(() => readRoleplayDiscovery());
  // P0=列表；enrich=收藏/会话史/角标。列表有缓存或首包结算后 markCriticalSettled。
  const enrichReady = useEntryEnrichReady();
  const [criticalVisualSettled, setCriticalVisualSettled] = useState(false);
  // entry-phase 是应用启动级状态，SPA 导航后通常已经放行；再加当前路由首图门槛，
  // 避免会话史、社交计数和角标在角色卡图片之前抢连接与主线程。
  const routeEnrichReady = enrichReady && criticalVisualSettled;
  const history = useConversationsQuery(undefined, routeEnrichReady);
  // message_count 不计虚拟开场白；只标记已确认的用户对话，未命中不代表从未聊过。
  const experiencedIds = useMemo(
    () => experiencedCharacterIds(history.data?.sessions ?? []),
    [history.data?.sessions]
  );
  const [restoreSnapshot, setRestoreSnapshot] = useState<LobbyReturnSnapshot | null>(() =>
    readLobbyReturnSnapshot()
  );
  const [isRestoring, setIsRestoring] = useState(() => restoreSnapshot !== null);
  const [sort, setSort] = useState<LobbySort>(restoreSnapshot?.sort ?? savedDiscovery.sort);
  const [query, setQuery] = useState(restoreSnapshot?.query ?? savedDiscovery.query);
  const [manualBatchChanged, setManualBatchChanged] = useState(false);
  const [tailRequested, setTailRequested] = useState(false);
  const {
    recommendation,
    resetVisit,
    data,
    isLoading,
    isError,
    isFetching,
    isFetchedAfterMount,
    refetch,
    usesDirectory,
    publicView,
    publicCheckedAt,
    hasUnloadedTail,
    tailFailed,
  } = useLobbyDiscoveryFeed({
    sort,
    search: !!query.trim(),
    restore: restoreSnapshot,
    manualChange: manualBatchChanged,
    tailRequested,
  });
  useEffect(() => {
    if (data !== undefined || isError) markCriticalSettled();
  }, [data, isError]);
  useEffect(() => {
    if (
      usesDirectory &&
      criticalVisualSettled &&
      data !== undefined &&
      !isRestoring &&
      !isFetching &&
      !isFetchedAfterMount
    )
      void refetch();
  }, [
    usesDirectory,
    criticalVisualSettled,
    data,
    isFetchedAfterMount,
    isFetching,
    isRestoring,
    refetch,
  ]);
  useEffect(() => {
    setCriticalVisualSettled(false);
  }, [sort]);
  useEffect(() => {
    if (data === undefined || criticalVisualSettled) return;
    // 图片始终不结算时也要放行非关键数据；缓存目录的后台校准由下面的 effect 决定是否需要。
    // 移动端兜底继续避开前 2 秒关键窗口，同时把超时纳入视觉终态，避免成功样本偏差。
    const timer = window.setTimeout(() => {
      setCriticalVisualSettled(true);
      markPageCriticalVisual(
        '/characters',
        'timeout',
        undefined,
        isFetching || isRestoring ? 'cache' : 'fetch'
      );
    }, CACHE_REVALIDATE_FALLBACK_MS[performancePolicy.platform]);
    return () => window.clearTimeout(timer);
  }, [criticalVisualSettled, data, isFetching, isRestoring, performancePolicy.platform]);
  // 大厅有本地缓存秒开：content 记用户看到列表的时刻，fresh 记最新列表到达的时刻，两者分开才看得出后端慢。
  const lobbyFresh = useFreshAfterFetch(isFetching, data !== undefined, isError);
  usePageReady(
    '/characters',
    data !== undefined && !isError && !isLoading,
    lobbyFresh,
    isError,
    data !== undefined && (isFetching || isRestoring) ? 'cache' : lobbyFresh ? 'fetch' : 'unknown'
  );
  const generalScrollRestored = useRef(false);
  useEffect(() => {
    rememberRoleplayDiscovery({ sort, query, favoritesOnly: false });
  }, [sort, query]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewTab, setPreviewTab] = useState<CharacterDetailTab>('intro');
  const [detailLoaded, setDetailLoaded] = useState(false);
  const [enteringId, setEnteringId] = useState<string | null>(null);
  const enteringRef = useRef(false);
  const restoredAnchorIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const changingBatchRef = useRef(false);
  const [batchNotice, setBatchNotice] = useState<{
    message: string;
    undoId?: string;
    retry?: 'refresh' | 'undo';
  } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>();
  const previousView = useRef<{
    public: boolean;
    tail: boolean;
    scrollY: number;
    renderLimit: number;
  }>();
  const batchScroll = useRef<number | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(noticeTimer.current);
    };
  }, []);

  const latestBadge = useLobbyLatestBadgeQuery({ enabled: routeEnrichReady });
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
      if (!enteringId) {
        setDetailLoaded(true);
        setPreviewTab('intro');
        setPreviewId(id);
      }
    },
    [enteringId]
  );

  const handleCharacterComments = useCallback(
    (id: string) => {
      if (!enteringId) {
        setDetailLoaded(true);
        setPreviewTab('comments');
        setPreviewId(id);
      }
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

  useEffect(() => {
    if (!restoreSnapshot) return;
    // 快照读入组件 state 后即可清掉共享存储；后续恢复只依赖本次挂载持有的副本，
    // 避免弱网等待期间旧快照被其他入口误复用。
    clearLobbyReturnSnapshot();
  }, [restoreSnapshot]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return characters;
    return characters
      .map((c) => ({ c, s: scoreMatch(c, q) }))
      .filter(({ s }) => s > 0)
      .sort((a, b) => b.s - a.s)
      .map(({ c }) => c);
  }, [characters, query]);

  useLayoutEffect(() => {
    if (generalScrollRestored.current || restoreSnapshot || !data || isLoading) return;
    generalScrollRestored.current = true;
    restoreRoleplayScroll('/characters');
  }, [data, isLoading, restoreSnapshot]);

  const [renderLimit, setRenderLimit] = useState(listBudget.initialRenderCount);
  // 从详情返回靠锚点卡片还原滚动位置：锚点及其之前的卡必须已挂载，之后只需再多挂约一屏。
  // 不能整表一次挂全：整页在 invisible 状态下同步挂几十上百张卡，返回时就是“闪一下再卡一下”。
  // 该值只依赖挂载时持有的快照，恢复结束后不会回落，避免已显示的卡被卸载。
  const restoreFloor = useMemo(() => {
    if (!restoreSnapshot || manualBatchChanged) return 0;
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
  }, [filtered, manualBatchChanged, restoreSnapshot]);
  const effectiveLimit = Math.max(renderLimit, restoreFloor);
  // 搜索时结果通常很少且用户在等结果，直接全量，不让命中的卡被分批延迟。
  const renderAll = query.trim() !== '';
  const visibleCharacters = useMemo(
    () => (renderAll ? filtered : filtered.slice(0, effectiveLimit)),
    [filtered, renderAll, effectiveLimit]
  );
  const criticalCharacterId = visibleCharacters[0]?.id;

  useLobbyExposures({
    enabled:
      sort === 'recommended' &&
      !query.trim() &&
      !publicView &&
      recommendation.ready &&
      recommendation.settled &&
      recommendation.data?.enabled === true &&
      !isRestoring &&
      !previewId &&
      !enteringId,
    scope: recommendation.scope,
    batchId: recommendation.data?.batch_id,
    characterIds: visibleCharacters.map((character) => character.id),
  });

  useLayoutEffect(() => {
    if (batchScroll.current === null) return;
    window.scrollTo({ top: batchScroll.current, behavior: 'auto' });
    batchScroll.current = null;
  }, [recommendation.data?.batch_id]);

  const changeBatch = async (action: 'refresh' | 'undo' = 'refresh', undoId?: string) => {
    if (recommendation.pending || changingBatchRef.current) return;
    changingBatchRef.current = true;
    const scopeAtStart = recommendation.scope;
    clearTimeout(noticeTimer.current);
    const before = recommendation.data;
    const view = {
      public: !!publicView,
      tail: tailRequested,
      scrollY: window.scrollY,
      renderLimit: effectiveLimit,
    };
    if (action === 'undo' && previousView.current?.public && undoId === 'public-view') {
      const previous = previousView.current;
      previousView.current = undefined;
      changingBatchRef.current = false;
      setManualBatchChanged(false);
      setTailRequested(previous.tail);
      setRenderLimit(previous.renderLimit);
      window.requestAnimationFrame(() =>
        window.scrollTo({ top: previous.scrollY, behavior: 'auto' })
      );
      setBatchNotice({ message: '已回到上一批' });
      noticeTimer.current = setTimeout(() => setBatchNotice(null), 8000);
      return;
    }
    const result =
      action === 'undo' && undoId
        ? await recommendation.undo(undoId)
        : await recommendation.refresh();
    changingBatchRef.current = false;
    if (!mountedRef.current || lobbyViewerScope() !== scopeAtStart) return;
    if (!result) {
      setBatchNotice({
        message: action === 'undo' ? '暂时没能撤回，再试一下' : '没换成功，原来的还在',
        retry: action,
        undoId,
      });
      return;
    }
    // A successful response can contain the current batch when the undo window
    // expired or another window moved on. Only the requested ID proves restoration.
    if (action === 'undo' && (!result.enabled || result.batch_id !== undoId)) {
      previousView.current = undefined;
      batchScroll.current = null;
      setBatchNotice({ message: '推荐已更新，暂时不能撤回' });
      noticeTimer.current = setTimeout(() => setBatchNotice(null), 8000);
      return;
    }
    clearLobbyReturnSnapshot();
    setManualBatchChanged(true);
    if (action === 'undo') {
      const previous = previousView.current;
      batchScroll.current = previous?.scrollY ?? 0;
      setTailRequested(previous?.tail ?? false);
      setRenderLimit(previous?.renderLimit ?? listBudget.initialRenderCount);
      previousView.current = undefined;
      setBatchNotice({ message: '已回到上一批' });
    } else {
      previousView.current = view;
      setTailRequested(false);
      batchScroll.current = 0;
      setRenderLimit(listBudget.initialRenderCount);
      setBatchNotice({
        message: result.batch_id !== before?.batch_id ? '换一批，看看新的相遇' : '推荐已更新',
        undoId: view.public
          ? 'public-view'
          : result.previous_batch_id === before?.batch_id
            ? (result.previous_batch_id ?? undefined)
            : undefined,
      });
    }
    // The response may already have committed before the event continuation runs.
    window.requestAnimationFrame(() => {
      if (!mountedRef.current || batchScroll.current === null) return;
      window.scrollTo({ top: batchScroll.current, behavior: 'auto' });
      batchScroll.current = null;
    });
    noticeTimer.current = setTimeout(() => setBatchNotice(null), 8000);
  };

  useCharacterSocialsQuery(
    visibleCharacters.map((character) => character.id),
    routeEnrichReady
  );

  // 按滚动位置补齐，而不是在空闲帧定时补：定时补会在路由 transition 渲染让出主线程的间隙里
  // 触发默认优先级的 setState，同步挂一批卡并打断导航，表现为底部 tab 高亮已变但页面不跳转。
  // 哨兵只在用户接近列表底部时才触发；每批挂完 effectiveLimit 变化会重建观察器，
  // 哨兵仍在范围内就继续补，直到它被推到范围之外。
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const hasMoreToRender = !renderAll && (effectiveLimit < filtered.length || hasUnloadedTail);
  useEffect(() => {
    const node = loadMoreRef.current;
    if (!hasMoreToRender || !node) return;
    const grow = () => {
      if (hasUnloadedTail && effectiveLimit >= filtered.length) setTailRequested(true);
      setRenderLimit((limit) => Math.max(limit, restoreFloor) + listBudget.renderBatchSize);
    };
    if (typeof IntersectionObserver === 'undefined') {
      // Even an older WebView waits for scroll demand before downloading the tail.
      const onScroll = () => {
        if (node.getBoundingClientRect().top <= window.innerHeight + 250) grow();
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      return () => window.removeEventListener('scroll', onScroll);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) grow();
      },
      { rootMargin: listBudget.renderMoreRootMargin }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMoreToRender, hasUnloadedTail, effectiveLimit, filtered.length, listBudget, restoreFloor]);

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
        // The selected ID may already be in the resolved list before its card is mounted.
        // Give the real anchor a chance before falling back to a neighbour or a scroll offset.
        if (!element) {
          if (!allowScrollFallback && filtered.some((card) => card.id === id)) return false;
          continue;
        }
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
    [filtered, finishRestore, isError, restoreSnapshot]
  );

  useLayoutEffect(() => {
    if (!isRestoring || isLoading) return;
    restoreFromSnapshot(false);
  }, [isLoading, isRestoring, restoreFromSnapshot]);

  useEffect(() => {
    if (!isRestoring || isLoading) return;
    const timer = window.setTimeout(() => {
      restoreFromSnapshot(true);
    }, RESTORE_DEADLINE_MS);
    return () => window.clearTimeout(timer);
  }, [isRestoring, isLoading, restoreFromSnapshot]);

  // The card can move *after* the first correct scroll: offscreen rows replace their
  // intrinsic estimates or Next restores the document scroll.
  // Keep the already visible anchor steady through those layout changes, never through user input.
  useLayoutEffect(() => {
    const id = restoredAnchorIdRef.current;
    if (!restoreSnapshot || isRestoring || manualBatchChanged || !id) return;
    const anchor = findLobbyCardElement(id);
    if (!anchor) return;
    let frame = 0;
    let stopped = false;
    const align = () => {
      frame = 0;
      if (stopped || !anchor.isConnected) return;
      const top = clampScrollY(
        window.scrollY + anchor.getBoundingClientRect().top - restoreSnapshot.anchorViewportTop
      );
      if (Math.abs(top - window.scrollY) > 1) window.scrollTo({ top, behavior: 'instant' });
    };
    const schedule = () => {
      if (!stopped && !frame) frame = window.requestAnimationFrame(align);
    };
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : undefined;
    observer?.observe(document.body);
    if (anchor.parentElement) observer?.observe(anchor.parentElement);
    const inputEvents = ['pointerdown', 'touchstart', 'wheel', 'keydown'] as const;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
      window.clearTimeout(deadline);
      window.removeEventListener('scroll', schedule);
      document.removeEventListener('load', schedule, true);
      document.removeEventListener('contentvisibilityautostatechange', schedule, true);
      for (const type of inputEvents) window.removeEventListener(type, stop, true);
    };
    const deadline = window.setTimeout(stop, RESTORE_DEADLINE_MS);
    for (const type of inputEvents)
      window.addEventListener(type, stop, { capture: true, passive: true });
    window.addEventListener('scroll', schedule, { passive: true });
    document.addEventListener('load', schedule, true);
    document.addEventListener('contentvisibilityautostatechange', schedule, true);
    schedule();
    return stop;
  }, [isRestoring, restoreSnapshot, manualBatchChanged]);

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
        favoritesOnly: false,
        anchorCharacterId: characterId,
        neighborCharacterIds: neighborIds(loadedCharacterIds, characterId),
        loadedCharacterIds,
        anchorViewportTop: rect?.top ?? 0,
        scrollY: window.scrollY,
        viewportWidth: window.innerWidth,
        publicHead:
          sort === 'recommended' && !query.trim() && publicView
            ? {
                cards: characters.slice(0, 12),
                checkedAt: publicCheckedAt,
                hasTail: hasUnloadedTail || characters.length > 12,
              }
            : undefined,
        recommendationBatchId:
          sort === 'recommended' && !query.trim() && !publicView
            ? recommendation.data?.batch_id
            : null,
      });
    },
    [
      filtered,
      query,
      recommendation.data?.batch_id,
      sort,
      publicView,
      publicCheckedAt,
      characters,
      hasUnloadedTail,
    ]
  );

  const handleImageSettled = useCallback(
    (characterId: string, outcome: 'loaded' | 'error') => {
      if (characterId === criticalCharacterId) {
        setCriticalVisualSettled(true);
        markPageCriticalVisual(
          '/characters',
          outcome,
          undefined,
          data !== undefined && (isFetching || isRestoring) ? 'cache' : 'fetch'
        );
      }
    },
    [criticalCharacterId, data, isFetching, isRestoring]
  );

  useEffect(() => {
    const first = visibleCharacters[0];
    if (data === undefined || isError) return;
    if (!first || !first.avatar_url) {
      setCriticalVisualSettled(true);
      markPageCriticalVisual(
        '/characters',
        'absent',
        undefined,
        isFetching || isRestoring ? 'cache' : 'fetch'
      );
    }
  }, [data, isError, isFetching, isRestoring, visibleCharacters]);

  const hiddenWhileRestoring = isRestoring ? 'invisible' : undefined;

  // 搜索框单独抽出,在 loading / 空态下也保持挂载,避免输入时焦点跳掉
  const searchBar = (
    <div
      className={cn(
        'mx-auto flex w-full max-w-screen-xl items-center gap-2 px-4 pb-2 pt-2 sm:px-6 lg:px-8',
        hiddenWhileRestoring
      )}
    >
      <div className="relative min-w-0 flex-1">
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
          placeholder="角色、标签或作者"
          className={cn(
            'h-10 rounded-full border-border bg-card pl-10 pr-3 text-foreground placeholder:text-muted-foreground/70 focus-visible:ring-ring/50 focus-visible:bg-secondary transition-all',
            query && 'pr-10'
          )}
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
      <Link
        href="/wishes?from=characters"
        className="group inline-flex min-h-11 shrink-0 items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="inline-flex h-10 items-center gap-1.5 rounded-full border border-primary/15 bg-primary/5 px-2.5 text-[12px] font-medium text-foreground/80 transition-colors group-hover:bg-primary/10 group-hover:text-foreground group-active:bg-primary/15">
          <Sparkles className="size-3.5 text-primary/80" strokeWidth={1.6} aria-hidden />
          许个愿
        </span>
      </Link>
    </div>
  );

  // 切换只改列表顺序，搜索词与卡片上的既有能力都保持不变。
  const sortTabs = (
    <div
      className={cn(
        'mx-auto flex w-full max-w-screen-xl items-center gap-2 px-4 pb-1 pt-1.5 sm:px-6 lg:px-8',
        hiddenWhileRestoring
      )}
    >
      <div role="tablist" aria-label="角色排序" className="flex items-center gap-2">
        {LOBBY_TABS.map((tab) => {
          const active = sort === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                if (sort !== tab.value) {
                  cancelRestore();
                  setRestoreSnapshot(null);
                  resetVisit();
                  setTailRequested(false);
                  setManualBatchChanged(false);
                  setRenderLimit(listBudget.initialRenderCount);
                  setBatchNotice(null);
                  previousView.current = undefined;
                  setSort(tab.value);
                }
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
      {sort === 'recommended' && !query.trim() && (recommendation.data?.enabled || publicView) ? (
        <button
          type="button"
          aria-label="换一批推荐角色"
          aria-busy={recommendation.pending}
          disabled={recommendation.pending || (!publicView && !recommendation.ready)}
          onClick={() => void changeBatch()}
          className="ml-auto inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-card hover:text-foreground active:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <RefreshCw
            className={cn(
              'size-3.5',
              recommendation.pending && 'animate-spin motion-reduce:animate-none'
            )}
            strokeWidth={1.7}
            aria-hidden
          />
          换一批
        </button>
      ) : null}
    </div>
  );

  const listHeader = (
    <>
      <RoleplayHeader active="discover" recommended={sort === 'recommended' && !query.trim()}>
        {searchBar}
      </RoleplayHeader>
      {sortTabs}
      {batchNotice && sort === 'recommended' ? (
        <div
          role="status"
          className="fixed inset-x-4 bottom-[calc(var(--app-nav-space)+0.75rem)] z-40 mx-auto flex max-w-sm items-center justify-between gap-3 rounded-2xl border border-white/10 bg-[#242125]/95 px-4 py-1.5 text-[12px] text-foreground shadow-lg backdrop-blur-xl"
        >
          <span>{batchNotice.message}</span>
          {batchNotice.retry ? (
            <button
              type="button"
              disabled={recommendation.pending}
              onClick={() => void changeBatch(batchNotice.retry, batchNotice.undoId)}
              className="min-h-11 shrink-0 rounded-lg px-2 font-medium text-primary disabled:opacity-50"
            >
              重试
            </button>
          ) : batchNotice.undoId ? (
            <button
              type="button"
              disabled={recommendation.pending}
              onClick={() => void changeBatch('undo', batchNotice.undoId)}
              className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2 font-medium text-primary disabled:opacity-50"
            >
              <Undo2 className="size-3.5" aria-hidden />
              撤回
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );

  if (isLoading) {
    return (
      <>
        {listHeader}
        <div
          className={cn(
            'mx-auto grid w-full max-w-screen-xl grid-cols-2 gap-2.5 px-3 py-6 sm:px-6 lg:px-8',
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

  if (isError && !data) {
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
          <p className="text-center text-[13px] text-muted-foreground">
            {`没有匹配「${query}」的角色`}
          </p>
          <p className="text-center text-[11px] text-muted-foreground/80">
            换个名字或标签试试，也可以告诉创作者你想玩什么。
          </p>
          <Link
            href="/wishes?from=characters&compose=1"
            className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 px-5 text-sm text-primary"
          >
            <Sparkles className="size-4" aria-hidden />
            许个愿，让创作者看见
          </Link>
        </div>
      ) : (
        <div
          className={cn(
            'mx-auto grid w-full max-w-screen-xl grid-cols-2 gap-2.5 px-3 pb-10 pt-2 sm:grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))] sm:gap-4 sm:px-6 lg:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] lg:px-8',
            hiddenWhileRestoring
          )}
        >
          {visibleCharacters.map((c, index) => (
            <CharacterCard
              key={c.id}
              character={c}
              experienced={experiencedIds.has(c.id)}
              eager={index < listBudget.eagerImageCount}
              priority={index < listBudget.highPriorityImageCount}
              onImageSettled={handleImageSettled}
              onSelect={handleSelectCharacter}
              onComments={handleCharacterComments}
            />
          ))}
        </div>
      )}
      {/* 渲染哨兵放在网格外：恢复滚动期间网格带 invisible，哨兵不受影响。 */}
      {hasMoreToRender ? (
        <div ref={loadMoreRef} aria-hidden="true" className="h-px w-full" />
      ) : null}
      {tailFailed ? (
        <button
          type="button"
          onClick={() => void refetch()}
          className="mx-auto block min-h-11 px-3 text-sm text-muted-foreground"
        >
          更多角色暂时没加载出来，点此重试
        </button>
      ) : null}
      {detailLoaded ? (
        <CharacterDetailSheet
          characterId={previewId}
          initialTab={previewTab}
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
              // 当前本来就在大厅，直接 replace('/characters') 可能被 Next.js 当成同路由而忽略。
              // 唯一查询参数会启动一笔新的 SPA 导航，并让 App Router 放弃在途角色导航，
              // 同时保留 query cache 与 Telegram SDK。
              router.replace(`/characters?entry_cancelled=${Date.now()}`);
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
            rememberRoleplayScroll('/characters');
            router.push(chatEntryPath(id, { sessionId, source: 'discover' }));
          }}
        />
      ) : null}
    </>
  );
}
