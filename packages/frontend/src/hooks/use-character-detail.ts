'use client';

import { useState, useEffect } from 'react';
import type { CharacterDetail } from '@miniapp/shared';
import { fetchCharacterById } from '@/lib/api/characters';

export function useCharacterDetail(id: string) {
  const [character, setCharacter] = useState<CharacterDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchCharacterById(id)
      .then((data) => setCharacter(data.character))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  return { character, loading, error };
}