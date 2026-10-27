'use client';

import { useEffect } from 'react';
import { create } from 'zustand';

import { getRawInitData } from '@/lib/telegram/auth';
import { parseTelegramUser } from '@/lib/telegram/user';

export interface DramaProgress {
  videoId: string;
  episode: number;
  seconds: number;
  duration: number;
  updatedAt: number;
  completed: boolean;
  /** 0 为短暂试看；缺省是旧版观看记录，按原更新时间兼容。 */
  engagedAt?: number;
}

interface DramaBrowseState {
  tab: 'theater' | 'library';
  activeId: string | null;
  keyword: string;
  category: string;
  sort: 'recommended' | 'latest';
  scroll: number;
  searchReturnScroll: number | null;
  libraryFilter: 'saved' | 'recent';
  libraryPositions: Record<'saved' | 'recent', DramaLibraryPosition>;
}

export interface DramaLibraryPosition {
  scroll: number;
  anchorId: string | null;
  anchorOffset: number;
}

interface DramaLibraryState {
  hydrated: boolean;
  storageKey: string;
  persistent: boolean;
  saved: string[];
  history: Record<string, DramaProgress>;
  browse: DramaBrowseState;
  playbackControlsVisible: boolean;
  setPlaybackControlsVisible: (value: boolean | ((previous: boolean) => boolean)) => void;
  muted: boolean;
  speed: number;
  setPlaybackPreferences: (patch: Partial<Pick<DramaLibraryState, 'muted' | 'speed'>>) => void;
  hydrate: () => void;
  toggleSaved: (id: string) => void;
  saveProgress: (id: string, progress: Omit<DramaProgress, 'updatedAt' | 'engagedAt'>) => void;
  markEngaged: (id: string) => void;
  setBrowse: (patch: Partial<DramaBrowseState>) => void;
}

const defaultBrowse: DramaBrowseState = {
  tab: 'theater',
  activeId: null,
  keyword: '',
  category: '全部',
  sort: 'recommended',
  scroll: 0,
  searchReturnScroll: null,
  libraryFilter: 'saved',
  libraryPositions: {
    saved: { scroll: 0, anchorId: null, anchorOffset: 0 },
    recent: { scroll: 0, anchorId: null, anchorOffset: 0 },
  },
};
const MAX_ENTRIES = 200;
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;

function readHistory(value: unknown): Record<string, DramaProgress> {
  if (!record(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([id, item]) =>
          validId(id) &&
          record(item) &&
          validId(item.videoId) &&
          finite(item.episode, 100000) &&
          item.episode >= 1 &&
          finite(item.seconds, 604800) &&
          finite(item.duration, 604800) &&
          finite(item.updatedAt, Number.MAX_SAFE_INTEGER) &&
          typeof item.completed === 'boolean'
      )
      .map(([id, item]) => {
        const p = item as unknown as DramaProgress;
        return [
          id,
          {
            videoId: p.videoId,
            episode: p.episode,
            seconds: p.seconds,
            duration: p.duration,
            updatedAt: p.updatedAt,
            completed: p.completed,
            ...(finite(p.engagedAt, Number.MAX_SAFE_INTEGER) ? { engagedAt: p.engagedAt } : {}),
          },
        ] as const;
      })
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_ENTRIES)
  );
}

// 这里只持久化有界的观看位置和ID；签名播放地址及Telegram凭证不落盘。
function persist(state: Pick<DramaLibraryState, 'storageKey' | 'saved' | 'history'>) {
  try {
    localStorage.setItem(
      state.storageKey,
      JSON.stringify({ saved: state.saved, history: state.history })
    );
    return true;
  } catch {
    return false;
  }
}

export const useDramaLibraryStore = create<DramaLibraryState>((set, get) => ({
  hydrated: false,
  storageKey: '',
  persistent: true,
  saved: [],
  history: {},
  browse: defaultBrowse,
  // 本次观看会话内沿用音量与倍速，自动换剧不能突然恢复声音。
  playbackControlsVisible: true,
  setPlaybackControlsVisible: (value) =>
    set((state) => ({
      playbackControlsVisible:
        typeof value === 'function' ? value(state.playbackControlsVisible) : value,
    })),
  muted: false,
  speed: 1,
  setPlaybackPreferences: (patch) => set(patch),
  hydrate: () => {
    const userId = parseTelegramUser(getRawInitData()).id;
    const storageKey = `st-drama-library-v1:${Number.isSafeInteger(userId) ? userId : 'local'}`;
    if (get().hydrated && get().storageKey === storageKey) return;
    let saved: string[] = [];
    let history: Record<string, DramaProgress> = {};
    let browse = { ...defaultBrowse, libraryPositions: { ...defaultBrowse.libraryPositions } };
    let persistent = true;
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
      if (record(raw)) {
        saved = Array.isArray(raw.saved)
          ? [...new Set(raw.saved.filter(validId))].slice(0, MAX_ENTRIES)
          : [];
        history = readHistory(raw.history);
      }
    } catch {
      persistent = false;
    }
    try {
      const raw: unknown = JSON.parse(sessionStorage.getItem(`${storageKey}:browse`) ?? '{}');
      if (record(raw)) {
        if (raw.tab === 'theater' || raw.tab === 'library') browse.tab = raw.tab;
        if (validId(raw.activeId)) browse.activeId = raw.activeId;
        if (typeof raw.keyword === 'string') browse.keyword = raw.keyword.slice(0, 100);
        if (typeof raw.category === 'string') browse.category = raw.category.slice(0, 30);
        if (raw.sort === 'latest') browse.sort = 'latest';
        if (finite(raw.scroll, 1000000)) browse.scroll = raw.scroll;
        if (finite(raw.searchReturnScroll, 1000000))
          browse.searchReturnScroll = raw.searchReturnScroll;
        if (raw.libraryFilter === 'recent') browse.libraryFilter = 'recent';
        if (record(raw.libraryPositions)) {
          for (const filter of ['saved', 'recent'] as const) {
            const position = raw.libraryPositions[filter];
            if (!record(position) || !finite(position.scroll, 1000000)) continue;
            browse.libraryPositions[filter] = {
              scroll: position.scroll,
              anchorId: validId(position.anchorId) ? position.anchorId : null,
              anchorOffset:
                typeof position.anchorOffset === 'number' &&
                Number.isFinite(position.anchorOffset) &&
                Math.abs(position.anchorOffset) <= 1000000
                  ? position.anchorOffset
                  : 0,
            };
          }
        }
      }
    } catch {
      /* 不可用时仍可在当前页面切换栏目。 */
    }
    set({ storageKey, saved, history, browse, persistent, hydrated: true });
  },
  toggleSaved: (id) => {
    if (!validId(id)) return;
    const state = get();
    const saved = state.saved.includes(id)
      ? state.saved.filter((item) => item !== id)
      : [id, ...state.saved].slice(0, MAX_ENTRIES);
    set({ saved, persistent: persist({ ...state, saved }) });
  },
  saveProgress: (id, progress) => {
    if (
      !validId(id) ||
      !validId(progress.videoId) ||
      !finite(progress.seconds, 604800) ||
      !finite(progress.duration, 604800) ||
      progress.episode < 1
    )
      return;
    const state = get();
    const history = Object.fromEntries(
      Object.entries({
        ...state.history,
        [id]: {
          ...progress,
          updatedAt: Date.now(),
          // 位置可以随时记，真正追剧的排序只由有效观看刷新。
          engagedAt: state.history[id]?.engagedAt ?? state.history[id]?.updatedAt ?? 0,
        },
      })
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .slice(0, MAX_ENTRIES)
    );
    set({ history, persistent: persist({ ...state, history }) });
  },
  markEngaged: (id) => {
    const state = get();
    const progress = state.history[id];
    if (!validId(id) || !progress) return;
    const history = { ...state.history, [id]: { ...progress, engagedAt: Date.now() } };
    set({ history, persistent: persist({ ...state, history }) });
  },
  setBrowse: (patch) => {
    const state = get();
    const browse = { ...state.browse, ...patch };
    set({ browse });
    try {
      sessionStorage.setItem(`${state.storageKey}:browse`, JSON.stringify(browse));
    } catch {
      /* 当前会话仍保留内存状态。 */
    }
  },
}));

export function useHydrateDramaLibrary() {
  const hydrated = useDramaLibraryStore((state) => state.hydrated);
  const hydrate = useDramaLibraryStore((state) => state.hydrate);
  useEffect(() => {
    hydrate();
  }, [hydrate]);
  return hydrated;
}
