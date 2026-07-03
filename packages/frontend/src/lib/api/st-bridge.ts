'use client';

import { useMutation } from '@tanstack/react-query';
import type { EnsureStCharacterData } from '@miniapp/shared';

import { apiClient } from './client';

/**
 * 懒下发：进入 /tavern/<characterId> 时确保「当前打开的这张卡」已落到
 * 该用户的 ST 数据目录，随后前端才 selectCharacter。
 */
async function postEnsureStCharacter(characterId: string): Promise<EnsureStCharacterData> {
  return apiClient<EnsureStCharacterData>(
    `/api/bridge/st-character/${encodeURIComponent(characterId)}`,
    { method: 'POST' }
  );
}

export function useEnsureStCharacterMutation() {
  return useMutation<EnsureStCharacterData, Error, string>({
    mutationFn: postEnsureStCharacter,
  });
}
