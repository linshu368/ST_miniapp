'use client';

import { useState, useEffect } from 'react';
import type { CharacterSummary } from '@miniapp/shared';
import { fetchCharacters } from '@/lib/api/characters';

export function useCharacters() {
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchCharacters()
      .then((data) => setCharacters(data.characters))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return { characters, loading, error };
}