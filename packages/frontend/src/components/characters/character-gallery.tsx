'use client';

import { useState } from 'react';

import { useCharactersQuery } from '@/lib/api/characters';

import { CharacterCard } from './character-card';
import { CharacterDetailSheet } from './character-detail-sheet';

export function CharacterGallery() {
  const { data, isLoading, isError } = useCharactersQuery();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 px-4 py-6" aria-label="加载中">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="aspect-[3/4] w-full animate-breath rounded-xl bg-card" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <p className="px-4 py-8 text-[13px] text-muted-foreground">门好像被风合上了。稍后再来。</p>
    );
  }

  const characters = data?.characters ?? [];

  if (characters.length === 0) {
    return <p className="px-4 py-8 text-[13px] text-muted-foreground/80">房间都空着。</p>;
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 px-4 pb-10 pt-2">
        {characters.map((c) => (
          <CharacterCard key={c.id} character={c} onSelect={setSelectedId} />
        ))}
      </div>
      <CharacterDetailSheet characterId={selectedId} onClose={() => setSelectedId(null)} />
    </>
  );
}
