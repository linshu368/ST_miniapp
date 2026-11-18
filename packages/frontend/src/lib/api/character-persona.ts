'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DeletePersonaData,
  GetCharacterMySettingsData,
  PutCharacterMySettingsRequest,
  SavePersonaData,
  SavePersonaRequest,
} from '@miniapp/shared';
import { apiClient } from './client';

export const characterPersonaKeys = {
  all: ['character-persona'] as const,
  settings: (characterId: string) =>
    [...characterPersonaKeys.all, 'settings', characterId] as const,
};

/**
 * 某张角色卡上的补充设定、人设选择，以及用户的人设库。
 * 人设库是全局的，但选择按卡记，所以 key 带 characterId；人设增删后让所有卡的缓存失效。
 */
export function useCharacterMySettingsQuery(characterId: string, enabled = true) {
  return useQuery<GetCharacterMySettingsData>({
    queryKey: characterPersonaKeys.settings(characterId),
    enabled,
    queryFn: () =>
      apiClient<GetCharacterMySettingsData>(
        `/api/characters/${encodeURIComponent(characterId)}/my-settings`
      ),
    staleTime: 60_000,
  });
}

/** 部分更新：notes 与 persona 各自独立保存，服务端返回最新的完整状态。 */
export function usePutCharacterMySettingsMutation(characterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: PutCharacterMySettingsRequest) =>
      apiClient<GetCharacterMySettingsData>(
        `/api/characters/${encodeURIComponent(characterId)}/my-settings`,
        { method: 'PUT', body: JSON.stringify(request) }
      ),
    onSuccess: (data) => {
      queryClient.setQueryData(characterPersonaKeys.settings(characterId), data);
    },
  });
}

/** 新建（不传 personaId）或保存已有人设。 */
export function useSavePersonaMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ personaId, body }: { personaId?: string; body: SavePersonaRequest }) =>
      personaId
        ? apiClient<SavePersonaData>(`/api/personas/${encodeURIComponent(personaId)}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          })
        : apiClient<SavePersonaData>('/api/personas', {
            method: 'POST',
            body: JSON.stringify(body),
          }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: characterPersonaKeys.all }),
  });
}

export function useDeletePersonaMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (personaId: string) =>
      apiClient<DeletePersonaData>(`/api/personas/${encodeURIComponent(personaId)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: characterPersonaKeys.all }),
  });
}
