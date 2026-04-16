'use client';

import { useState, useEffect } from 'react';
import type { CharacterDetail } from '@miniapp/shared';
import { mockCharacterDetails } from '@/lib/mock-data';

export function useCharacterDetail(id: string) {
  const [character, setCharacter] = useState<CharacterDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const detail = mockCharacterDetails[id] || null;
    setCharacter(detail);
    setLoading(false);
  }, [id]);

  return { character, loading, error: null };
}