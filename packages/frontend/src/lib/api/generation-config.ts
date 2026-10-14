'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  GetGenerationConfigData,
  PatchGenerationConfigData,
  PatchGenerationConfigRequest,
  UserGenerationConfig,
} from '@miniapp/shared';
import { apiClient } from './client';

export const generationConfigKeys = {
  detail: ['generation-config'] as const,
};

interface PatchGenerationConfigMutationOptions {
  shouldOptimisticallyUpdate?: (request: PatchGenerationConfigRequest) => boolean;
}

type GenerationConfigPatchField = keyof PatchGenerationConfigRequest;

interface OptimisticGenerationConfigContext {
  optimistic: boolean;
  previousConfig?: UserGenerationConfig;
}

function patchFields(request: PatchGenerationConfigRequest): GenerationConfigPatchField[] {
  return Object.keys(request) as GenerationConfigPatchField[];
}

/** 只覆盖本次 PATCH 指定的字段，避免并发保存时旧响应抹掉其他乐观值。 */
export function mergeGenerationConfigPatch(
  current: GetGenerationConfigData,
  patch: PatchGenerationConfigRequest
): GetGenerationConfigData {
  return {
    ...current,
    config: {
      ...current.config,
      ...patch,
    },
  };
}

/**
 * 单字段失败只回滚仍停留在该次乐观值上的字段。
 * 若用户随后又改过同一字段，或另一个 mutation 已更新它，就保留更新后的值。
 */
export function rollbackGenerationConfigPatch(
  current: GetGenerationConfigData,
  request: PatchGenerationConfigRequest,
  previousConfig: UserGenerationConfig
): GetGenerationConfigData {
  const config = { ...current.config };
  for (const field of patchFields(request)) {
    if (Object.is(config[field], request[field])) {
      Object.assign(config, { [field]: previousConfig[field] });
    }
  }
  return { ...current, config };
}

/**
 * 服务端响应只确认本次写入的字段；其余字段可能已有另一笔乐观更新，不能被旧快照覆盖。
 */
export function mergeGenerationConfigResponse(
  current: GetGenerationConfigData,
  response: PatchGenerationConfigData,
  request: PatchGenerationConfigRequest
): GetGenerationConfigData {
  const config = { ...current.config };
  for (const field of patchFields(request)) {
    if (Object.is(config[field], request[field])) {
      Object.assign(config, { [field]: response.config[field] });
    }
  }
  return {
    ...current,
    config,
    word_count_tiers: response.word_count_tiers,
  };
}

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
export function usePatchGenerationConfigMutation({
  shouldOptimisticallyUpdate,
}: PatchGenerationConfigMutationOptions = {}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: PatchGenerationConfigRequest) =>
      apiClient<PatchGenerationConfigData>('/api/v1/generation-config', {
        method: 'PATCH',
        body: JSON.stringify(request),
      }),
    onMutate: async (request): Promise<OptimisticGenerationConfigContext> => {
      const optimistic = shouldOptimisticallyUpdate?.(request) ?? false;
      if (!optimistic) return { optimistic };

      await queryClient.cancelQueries({ queryKey: generationConfigKeys.detail });
      const previous = queryClient.getQueryData<GetGenerationConfigData>(
        generationConfigKeys.detail
      );

      if (previous) {
        queryClient.setQueryData<GetGenerationConfigData>(
          generationConfigKeys.detail,
          mergeGenerationConfigPatch(previous, request)
        );
      }

      return { optimistic, previousConfig: previous?.config };
    },
    onError: (_error, _request, context) => {
      if (context?.optimistic && context.previousConfig) {
        queryClient.setQueryData<GetGenerationConfigData>(generationConfigKeys.detail, (current) =>
          current
            ? rollbackGenerationConfigPatch(current, _request, context.previousConfig!)
            : current
        );
      }
    },
    onSuccess: (data, request, context) => {
      if (!context?.optimistic) {
        queryClient.setQueryData<GetGenerationConfigData>(generationConfigKeys.detail, data);
        return;
      }

      queryClient.setQueryData<GetGenerationConfigData>(generationConfigKeys.detail, (current) =>
        current ? mergeGenerationConfigResponse(current, data, request) : data
      );
    },
  });
}
