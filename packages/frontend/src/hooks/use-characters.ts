'use client';

import { useState, useEffect } from 'react';
import type { CharacterSummary } from '@miniapp/shared';
import { mockCharacters } from '@/lib/mock-data';
import { fetchCharacters } from '@/lib/api/characters';

const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === 'true';

export function useCharacters() {
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (USE_MOCK) {
      // PM 阶段：直接用 mock 数据
      setCharacters(mockCharacters);
      setLoading(false);
      return;
    }

    // 开发阶段：调用真实 API
    fetchCharacters()
      .then((data) => {
        setCharacters(data.characters);
      })
      .catch((err) => {
        setError(err.message);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  return { characters, loading, error };
}