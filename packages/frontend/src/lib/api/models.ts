'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './client';
import type {
  GetModelCatalogData,
  GetModelTiersData,
  SelectModelData,
  SelectModelRequest,
} from '@miniapp/shared';
import { MODEL_CATALOG_STALE_TIME_MS } from './model-cache-policy';

const MODEL_CATALOG_CACHE_KEY = 'miniapp:model-catalog:last-good:v2';

export const modelCatalogKeys = {
  detail: ['modelCatalog'] as const,
};

export function useModelTiersQuery() {
  return useQuery({
    queryKey: ['modelTiers'],
    queryFn: async () => {
      const data = await apiClient<GetModelTiersData>('/api/platform/models');
      return data;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

export function useModelCatalogQuery() {
  return useQuery({
    queryKey: modelCatalogKeys.detail,
    queryFn: async () => {
      try {
        const data = await apiClient<GetModelCatalogData>('/api/v1/models/config');
        writeLastGoodCatalog(data);
        return data;
      } catch (error) {
        const cached = readLastGoodCatalog();
        if (cached) return cached;
        throw error;
      }
    },
    staleTime: MODEL_CATALOG_STALE_TIME_MS,
    placeholderData: readLastGoodCatalog,
  });
}

/**
 * 选中态立刻写进目录缓存，目录内容本身不变。
 * 失败时只回滚「当前展示的仍是这次点击」的缓存，避免连点时把更新的选择盖掉。
 */
export function useSelectModelMutation() {
  const queryClient = useQueryClient();

  return useMutation<
    SelectModelData,
    Error,
    SelectModelRequest,
    { previous?: GetModelCatalogData }
  >({
    mutationFn: async (request: SelectModelRequest) =>
      apiClient<SelectModelData>('/api/v1/models/select', {
        method: 'POST',
        body: JSON.stringify(request),
      }),
    onMutate: async (request) => {
      await queryClient.cancelQueries({ queryKey: modelCatalogKeys.detail });
      const previous = queryClient.getQueryData<GetModelCatalogData>(modelCatalogKeys.detail);
      const next = applySelectedModelToCatalog(previous, { model_id: request.model_id });
      if (next) queryClient.setQueryData(modelCatalogKeys.detail, next);
      return { previous };
    },
    onError: (_error, request, context) => {
      const current = queryClient.getQueryData<GetModelCatalogData>(modelCatalogKeys.detail);
      if (current?.selected_model_id !== request.model_id) return;
      if (context?.previous) {
        queryClient.setQueryData(modelCatalogKeys.detail, context.previous);
      }
    },
    onSuccess: (data, request) => {
      const current = queryClient.getQueryData<GetModelCatalogData>(modelCatalogKeys.detail);
      if (current && current.selected_model_id !== request.model_id) return;
      const next = applySelectedModelToCatalog(current, {
        model_id: data.model_id,
        openrouter_model_id: data.openrouter_model_id,
      });
      if (next) {
        queryClient.setQueryData(modelCatalogKeys.detail, next);
        writeLastGoodCatalog(next);
      }
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

function readLastGoodCatalog(): GetModelCatalogData | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(MODEL_CATALOG_CACHE_KEY);
    return raw ? (JSON.parse(raw) as GetModelCatalogData) : undefined;
  } catch {
    return undefined;
  }
}

function writeLastGoodCatalog(data: GetModelCatalogData): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MODEL_CATALOG_CACHE_KEY, JSON.stringify(data));
  } catch {
    // Storage may be unavailable inside hardened WebViews; React Query still keeps memory cache.
  }
}
