'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './client';
import {
  GetModelCatalogDataSchema,
  isFreeZoneModelId,
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
  select: ['modelCatalog', 'select'] as const,
  context: (userId: number | undefined, characterId?: string) =>
    ['modelCatalog', userId ?? 'unidentified', characterId ?? null] as const,
};

export function useModelCatalogQuery({
  enabled = true,
  characterId,
}: { enabled?: boolean; characterId?: string } = {}) {
  const userId = parseTelegramUser(getRawInitData()).id;
  return useQuery<GetModelCatalogData>({
    queryKey: modelCatalogKeys.context(userId, characterId),
    enabled,
    queryFn: async ({ signal }) => {
      try {
        const suffix = characterId ? `?character_id=${encodeURIComponent(characterId)}` : '';
        const data = await apiClient<GetModelCatalogData>(`/api/v1/models/config${suffix}`, {
          signal,
          timeoutMs: 10_000,
          totalTimeoutMs: 10_000,
        });
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        writeLastGoodCatalog(data, userId, characterId);
        return data;
      } catch (error) {
        if (signal.aborted) throw error;
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
 * 保留已确认的模型，保存成功后才更新展示。
 * 同一QueryClient内串行选择；失败只重读校准，不自动重发写入。
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
    mutationKey: modelCatalogKeys.select,
    retry: false,
    scope: { id: 'chat-model-selection' },
    mutationFn: async (request: SelectModelRequest) =>
      apiClient<SelectModelData>('/api/v1/models/select', {
        method: 'POST',
        body: JSON.stringify({ ...request, ...(characterId ? { character_id: characterId } : {}) }),
        timeoutMs: 10_000,
        totalTimeoutMs: 10_000,
        transportRetry: false,
      }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey });
      // Keep the last confirmed model visible while the selection is being saved.
      const previous =
        queryClient.getQueryData<GetModelCatalogData>(queryKey) ??
        readLastGoodCatalog(userId, characterId);
      return { previous };
    },
    onError: async () => {
      // A failed response cannot prove that the server rolled back the selection.
      await queryClient.invalidateQueries({ queryKey });
    },
    onSuccess: (data, _request, context) => {
      const current = queryClient.getQueryData<GetModelCatalogData>(queryKey) ?? context?.previous;
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

/**
 * 开通 VIP 后自动选回畅聊：开通礼让畅聊对他开放，拉一次最新目录，开放且有在架模型就选第一个。
 * 已经选着免费模型就不动。失败只是没自动选上，用户自己去面板选，不重试。
 */
export async function reselectFreeZoneAfterVip(): Promise<string | null> {
  const data = await apiClient<GetModelCatalogData>('/api/v1/models/config');
  const zone = data.free_zone;
  if (zone?.state !== 'open' || zone.models.length === 0) return null;
  if (isFreeZoneModelId(data.selected_model_id)) return data.selected_model_id;
  const target = zone.models[0]!.id;
  await apiClient<SelectModelData>('/api/v1/models/select', {
    method: 'POST',
    body: JSON.stringify({ model_id: target } satisfies SelectModelRequest),
  });
  return target;
}
