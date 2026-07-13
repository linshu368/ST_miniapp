'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Search, Sparkles, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { useCharactersQuery } from '@/lib/api/characters';
import { requestTelegramChatFullscreen } from '@/lib/telegram/init';

import { CharacterCard, lobbyImageUrl } from './character-card';
import { CharacterDetailSheet } from './character-detail-sheet';

const FIRST_SCREEN_IMAGE_COUNT = 6;
const LOBBY_CRITICAL_READY_EVENT = 'miniapp:lobby-critical-ready';

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
  const { data, isLoading, isError } = useCharactersQuery();
  const [query, setQuery] = useState('');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [enteringId, setEnteringId] = useState<string | null>(null);
  const enteringRef = useRef(false);
  const settledImageIdsRef = useRef(new Set<string>());
  const criticalReadySentRef = useRef(false);

  // 用户阅读角色详情时同步预取动态路由，减少点击进入后偶发等待路由资源的时间。
  useEffect(() => {
    if (previewId) router.prefetch(`/tavern/${previewId}`);
  }, [previewId, router]);

  const characters = useMemo(() => data?.characters ?? [], [data?.characters]);
  const firstScreenCharacters = useMemo(
    () => characters.slice(0, FIRST_SCREEN_IMAGE_COUNT),
    [characters]
  );
  const enteringCharacter = useMemo(
    () => characters.find((character) => character.id === enteringId) ?? null,
    [characters, enteringId]
  );

  const signalLobbyCriticalReady = useCallback(() => {
    if (criticalReadySentRef.current) return;
    criticalReadySentRef.current = true;
    performance.mark('lobby_first_screen_images_ready');
    document.documentElement.dataset.lobbyCriticalReady = 'true';
    window.dispatchEvent(new Event(LOBBY_CRITICAL_READY_EVENT));
  }, []);

  const handleImageSettled = useCallback(
    (id: string) => {
      settledImageIdsRef.current.add(id);
      if (
        firstScreenCharacters.length > 0 &&
        firstScreenCharacters.every(
          (character) => !character.avatar_url || settledImageIdsRef.current.has(character.id)
        )
      ) {
        signalLobbyCriticalReady();
      }
    },
    [firstScreenCharacters, signalLobbyCriticalReady]
  );

  useEffect(() => {
    if (characters.length === 0) return;
    performance.mark('lobby_cards_visible');
    settledImageIdsRef.current = new Set(
      firstScreenCharacters
        .filter((character) => !character.avatar_url)
        .map((character) => character.id)
    );

    if (firstScreenCharacters.every((character) => !character.avatar_url)) {
      signalLobbyCriticalReady();
    }

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

    const fallbackTimer = window.setTimeout(signalLobbyCriticalReady, 4_800);
    return () => {
      clearTimeout(fallbackTimer);
      preloadLinks.forEach((link) => link.remove());
    };
  }, [characters.length, firstScreenCharacters, signalLobbyCriticalReady]);
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
          className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40"
          aria-hidden="true"
        />
        <Input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索角色、标签或作者"
          className="h-10 rounded-full pl-10 pr-10 border-white/10 bg-white/5 text-white placeholder:text-white/30 focus-visible:ring-indigo-500/50 focus-visible:bg-white/10 transition-all"
          aria-label="搜索角色"
        />
        {query && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setQuery('')}
            aria-label="清空搜索"
            className="absolute right-1 top-1 h-8 w-8 rounded-full text-white/40 hover:text-white hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );

  if (isLoading) {
    return (
      <>
        {searchBar}
        <div
          className="mx-auto grid w-full max-w-screen-xl grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-3 px-4 py-6 sm:px-6 lg:px-8"
          aria-label="加载中"
        >
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="aspect-[3/4] w-full animate-breath rounded-[16px] bg-white/5 border border-white/5"
            />
          ))}
        </div>
      </>
    );
  }

  if (isError) {
    return (
      <>
        {searchBar}
        <p className="mx-auto max-w-screen-xl px-4 py-8 text-center text-[13px] text-white/50 sm:px-6 lg:px-8">
          门好像被风合上了。稍后再来。
        </p>
      </>
    );
  }

  if (characters.length === 0) {
    return (
      <>
        {searchBar}
        <p className="mx-auto max-w-screen-xl px-4 py-8 text-center text-[13px] text-white/50 sm:px-6 lg:px-8">
          空旷的空间，还没有角色到达。
        </p>
      </>
    );
  }

  return (
    <>
      {searchBar}
      {filtered.length === 0 ? (
        <div className="mx-auto flex max-w-screen-xl flex-col items-center gap-2 px-4 py-10 sm:px-6 lg:px-8">
          <p className="text-center text-[13px] text-white/50">没有匹配「{query}」的角色</p>
          <p className="text-center text-[11px] text-white/40">
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
          enteringRef.current = true;
          flushSync(() => setEnteringId(id));
          requestTelegramChatFullscreen();
          window.requestAnimationFrame(() => router.push(`/tavern/${id}`));
        }}
      />
      {enteringCharacter && (
        <div
          className="fixed inset-0 z-[70] flex flex-col items-center justify-center overflow-hidden bg-[#07050b] px-6 text-white"
          aria-live="polite"
          aria-busy="true"
        >
          {enteringCharacter.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={lobbyImageUrl(enteringCharacter.avatar_url)}
              alt=""
              className="absolute inset-0 h-full w-full scale-105 object-cover object-top opacity-25 blur-xl"
            />
          ) : null}
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_38%,rgba(124,58,237,0.28),rgba(7,5,11,0.94)_58%)]" />
          <div className="relative flex flex-col items-center">
            <div className="flex size-16 items-center justify-center rounded-full border border-white/15 bg-white/10 shadow-[0_0_36px_rgba(168,85,247,0.28)] backdrop-blur-xl">
              <Sparkles className="h-6 w-6 animate-pulse text-white" />
            </div>
            <p className="mt-5 text-sm font-semibold tracking-[0.18em]">正在进入角色</p>
            <p className="mt-2 max-w-[18rem] truncate text-xs text-white/45">
              {enteringCharacter.name}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
