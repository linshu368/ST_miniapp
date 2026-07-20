'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { useCharactersQuery } from '@/lib/api/characters';

import { CharacterCard, lobbyImageUrl } from './character-card';
import { CharacterDetailSheet } from './character-detail-sheet';

const FIRST_SCREEN_IMAGE_COUNT = 8;

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
          className="h-10 rounded-full border-border bg-card pl-10 pr-10 text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:ring-primary/40 transition-all"
          aria-label="搜索角色"
        />
        {query && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setQuery('')}
            aria-label="清空搜索"
            className="absolute right-1 top-1 h-8 w-8 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
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
              className="aspect-[3/4] w-full animate-breath rounded-[16px] border border-border bg-muted"
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
        <p className="mx-auto max-w-screen-xl px-4 py-8 text-center text-[13px] text-muted-foreground sm:px-6 lg:px-8">
          门好像被风合上了。稍后再来。
        </p>
      </>
    );
  }

  if (characters.length === 0) {
    return (
      <>
        {searchBar}
        <p className="mx-auto max-w-screen-xl px-4 py-8 text-center text-[13px] text-muted-foreground sm:px-6 lg:px-8">
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
          setEnteringId(id);
          router.push(`/tavern/${id}`);
        }}
      />
    </>
  );
}
