'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  GetGenerationConfigData,
  PatchGenerationConfigData,
  PatchGenerationConfigRequest,
} from '@miniapp/shared';
import { apiClient } from './client';

export const generationConfigKeys = {
  detail: ['generation-config'] as const,
};

/**
 * 用户级生成配置。对该用户的所有会话生效，没有会话级覆盖，
 * 所以 key 不带 sessionId，切会话不必重取。
 */
export function useGenerationConfigQuery(enabled = true) {
  return useQuery<GetGenerationConfigData>({
    queryKey: generationConfigKeys.detail,
    enabled,
    queryFn: async () => apiClient<GetGenerationConfigData>('/api/v1/generation-config'),
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * 只改三个 pref_* 字段。
 * 切模型不走这里——那要走 /api/v1/models/select，它带着「切到付费模型前先查余额」的闸门。
 */
export function usePatchGenerationConfigMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: PatchGenerationConfigRequest) =>
      apiClient<PatchGenerationConfigData>('/api/v1/generation-config', {
        method: 'PATCH',
        body: JSON.stringify(request),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData<GetGenerationConfigData>(generationConfigKeys.detail, {
        config: data.config,
      });
    },
  });
}
