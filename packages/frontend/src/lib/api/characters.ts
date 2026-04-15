import { apiClient } from './client';
import type { GetCharactersData, GetCharacterByIdData } from '@miniapp/shared';

export async function fetchCharacters(): Promise<GetCharactersData> {
  return apiClient<GetCharactersData>('/api/characters');
}

export async function fetchCharacterById(id: string): Promise<GetCharacterByIdData> {
  return apiClient<GetCharacterByIdData>(`/api/characters/${id}`);
}