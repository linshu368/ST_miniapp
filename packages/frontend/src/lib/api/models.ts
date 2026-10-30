'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './client';
import {
  GetModelCatalogDataSchema,
  type GetModelCatalogData,
  type SelectModelData,
  type SelectModelRequest,
} from '@miniapp/shared';
import { MODEL_CATALOG_STALE_TIME_MS } from './model-cache-policy';
import { getRawInitData } from '../telegram/auth';
import { parseTelegramUser } from '../telegram/user';

const MODEL_CATALOG_CACHE_KEY = 'miniapp:model-catalog:last-good:v3';

export const modelCatalogKeys = {
  detail: ['modelCatalog'] as const,
  context: (userId: number | undefined, characterId?: string) =>
    ['modelCatalog', userId ?? 'unidentified', characterId ?? null] as const,
};

export function useModelCatalogQuery({
  enabled = true,
  characterId,
}: { enabled?: boolean; characterId?: string } = {}) {
  const userId = parseTelegramUser(getRawInitData()).id;
  return useQuery({
    queryKey: modelCatalogKeys.context(userId, characterId),
    enabled,
    queryFn: async () => {
      try {
        const suffix = characterId ? `?character_id=${encodeURIComponent(characterId)}` : '';
        const data = await apiClient<GetModelCatalogData>(`/api/v1/models/config${suffix}`);
        writeLastGoodCatalog(data, userId, characterId);
        return data;
      } catch (error) {
        const cached = readLastGoodCatalog(userId, characterId);
        if (cached) return cached;
        throw error;
      }
    },
    staleTime: MODEL_CATALOG_STALE_TIME_MS,
    placeholderData: () => readLastGoodCatalog(userId, characterId),
  });
}

/**
 * 选中态立刻写进目录缓存，目录内容本身不变。
 * 失败时只回滚「当前展示的仍是这次点击」的缓存，避免连点时把更新的选择盖掉。
 */
export function useSelectModelMutation(characterId?: string) {
  const queryClient = useQueryClient();
  const userId = parseTelegramUser(getRawInitData()).id;
  const queryKey = modelCatalogKeys.context(userId, characterId);

  return useMutation<
    SelectModelData,
    Error,
    SelectModelRequest,
    { previous?: GetModelCatalogData }
  >({
    mutationFn: async (request: SelectModelRequest) =>
      apiClient<SelectModelData>('/api/v1/models/select', {
        method: 'POST',
        body: JSON.stringify({ ...request, ...(characterId ? { character_id: characterId } : {}) }),
      }),
    onMutate: async (request) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<GetModelCatalogData>(queryKey);
      const next = applySelectedModelToCatalog(previous, { model_id: request.model_id });
      if (next) queryClient.setQueryData(queryKey, next);
      return { previous };
    },
    onError: (_error, request, context) => {
      const current = queryClient.getQueryData<GetModelCatalogData>(queryKey);
      if (current?.selected_model_id !== request.model_id) return;
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSuccess: (data, request) => {
      const current = queryClient.getQueryData<GetModelCatalogData>(queryKey);
      if (current && current.selected_model_id !== request.model_id) return;
      const next = applySelectedModelToCatalog(current, {
        model_id: data.model_id,
        openrouter_model_id: data.openrouter_model_id,
      });
      if (next) {
        queryClient.setQueryData(queryKey, next);
        writeLastGoodCatalog(next, userId, characterId);
      }
      // Selection is global, but the prices belong to each character/user context.
      void queryClient.invalidateQueries({
        queryKey: modelCatalogKeys.detail,
        refetchType: 'none',
      });
    },
  });
}

export function applySelectedModelToCatalog(
  current: GetModelCatalogData | undefined,
  selected: { model_id: string; openrouter_model_id?: string }
): GetModelCatalogData | undefined {
  if (!current) return current;
  const nextOpenrouterId = selected.openrouter_model_id ?? current.selected_openrouter_model_id;
  if (
    current.selected_model_id === selected.model_id &&
    current.selected_openrouter_model_id === nextOpenrouterId
  ) {
    return current;
  }
  return {
    ...current,
    selected_model_id: selected.model_id,
    selected_openrouter_model_id: nextOpenrouterId,
  };
}

function readLastGoodCatalog(
  userId: number | undefined,
  characterId?: string
): GetModelCatalogData | undefined {
  if (typeof window === 'undefined' || userId === undefined) return undefined;
  try {
    const raw = window.localStorage.getItem(
      `${MODEL_CATALOG_CACHE_KEY}:${userId}:${characterId ?? 'global'}`
    );
    const parsed = raw ? GetModelCatalogDataSchema.safeParse(JSON.parse(raw)) : null;
    return parsed?.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function writeLastGoodCatalog(
  data: GetModelCatalogData,
  userId: number | undefined,
  characterId?: string
): void {
  if (typeof window === 'undefined' || userId === undefined) return;
  try {
    window.localStorage.setItem(
      `${MODEL_CATALOG_CACHE_KEY}:${userId}:${characterId ?? 'global'}`,
      JSON.stringify(data)
    );
  } catch {
    // Storage may be unavailable inside hardened WebViews; React Query still keeps memory cache.
  }
}
