// hooks/use-characters.ts
'use client';

import { useState, useEffect } from 'react';
import type { CharacterSummary } from '@miniapp/shared';
import { mockCharacters } from '@/lib/mock-data';

export function useCharacters() {
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // PM 阶段：直接用 mock 数据
    // 开发接真实数据时，将这里替换为 fetchCharacters() 调用
    setCharacters(mockCharacters);
    setLoading(false);
  }, []);

  return { characters, loading, error };
}