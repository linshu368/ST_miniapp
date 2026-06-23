'use client';

import { useMemo, useState } from 'react';
import { Search, Sparkles, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { useCharactersQuery } from '@/lib/api/characters';

import { CharacterCard } from './character-card';
import { CharacterDetailSheet } from './character-detail-sheet';

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
  const { data, isLoading, isError } = useCharactersQuery();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const characters = useMemo(() => data?.characters ?? [], [data?.characters]);
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
    <div className="px-4 pb-2 pt-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60"
          aria-hidden="true"
        />
        <Input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索角色、标签或作者"
          className="h-10 rounded-full pl-9 pr-9"
          aria-label="搜索角色"
        />
        {query && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setQuery('')}
            aria-label="清空搜索"
            className="absolute right-1 top-1 h-8 w-8 rounded-full text-muted-foreground/60 hover:text-foreground"
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
        <div className="grid grid-cols-2 gap-3 px-4 py-6" aria-label="加载中">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="aspect-[3/4] w-full animate-breath rounded-xl bg-card" />
          ))}
        </div>
      </>
    );
  }

  if (isError) {
    return (
      <>
        {searchBar}
        <p className="px-4 py-8 text-[13px] text-muted-foreground">门好像被风合上了。稍后再来。</p>
      </>
    );
  }

  if (characters.length === 0) {
    return (
      <>
        {searchBar}
        <p className="px-4 py-8 text-[13px] text-muted-foreground/80">房间都空着。</p>
      </>
    );
  }

  return (
    <>
      {searchBar}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-4 py-10">
          <p className="text-center text-[13px] text-muted-foreground/80">
            没有匹配「{query}」的角色
          </p>
          <Button
            variant="outline"
            onClick={() => {
              // TODO: 角色卡许愿池入口,功能待开发
            }}
            className="group relative overflow-hidden rounded-full border-indigo-300/30 bg-indigo-400/10 px-5 h-10 text-[13px] text-indigo-200/90 hover:bg-indigo-400/20 hover:text-indigo-100 border-0"
          >
            <Sparkles className="h-4 w-4 mr-2 transition-transform group-hover:rotate-12" />
            <span>没找到想要的?去许愿池</span>
          </Button>
          <p className="text-center text-[11px] text-muted-foreground/55">
            告诉我们你想要的角色,创作者会为你做出来
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 px-4 pb-10 pt-2">
          {filtered.map((c) => (
            <CharacterCard key={c.id} character={c} onSelect={setSelectedId} />
          ))}
        </div>
      )}
      <CharacterDetailSheet characterId={selectedId} onClose={() => setSelectedId(null)} />
    </>
  );
}
