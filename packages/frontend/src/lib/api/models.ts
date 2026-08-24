import { useMutation, useQuery } from '@tanstack/react-query';
import { apiClient } from './client';
import type {
  GetModelCatalogData,
  GetModelTiersData,
  SelectModelData,
  SelectModelRequest,
} from '@miniapp/shared';
import { MODEL_CATALOG_STALE_TIME_MS } from './model-cache-policy';

const MODEL_CATALOG_CACHE_KEY = 'miniapp:model-catalog:last-good:v2';

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
    queryKey: ['modelCatalog'],
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

export function useSelectModelMutation() {
  return useMutation({
    mutationFn: async (request: SelectModelRequest) =>
      apiClient<SelectModelData>('/api/v1/models/select', {
        method: 'POST',
        body: JSON.stringify(request),
      }),
  });
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
