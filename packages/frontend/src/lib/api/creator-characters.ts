'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CreateCreatorCharacterSchema,
  SaveCreatorCharacterSchema,
  PublishCreatorCharacterSchema,
  SetCreatorVisibilitySchema,
  CreatorCoverRequestSchema,
  CreatorCoverAssetSchema,
  CreatorPolishRequestSchema,
  CreatorPolishEventSchema,
  CreatorPresetDetailDataSchema,
  type CreateCreatorCharacterRequest,
  type SaveCreatorCharacterRequest,
  type PublishCreatorCharacterRequest,
  type SetCreatorVisibilityRequest,
  type GetCreatorCharacterData,
  type ListCreatorCharactersData,
  type CreatorCoverRequest,
  type CreatorCoverData,
  type CreatorPolishRequest,
  type CreatorPresetId,
  type CreatorPresetDetailData,
} from '@miniapp/shared';
import { getRawInitData, INIT_DATA_HEADER } from '@/lib/telegram/auth';
import { parseTelegramUser } from '@/lib/telegram/user';
import { API_URL, apiClient, toApiClientError } from './client';

function creatorClientIdentity(): string {
  return String(parseTelegramUser(getRawInitData()).id ?? 'local-browser');
}

export const creatorCharacterKeys = {
  all: ['creator-characters'] as const,
  list: (user = creatorClientIdentity()) => ['creator-characters', user, 'list'] as const,
  detail: (id: string, user = creatorClientIdentity()) =>
    ['creator-characters', user, 'detail', id] as const,
  cover: (id: string, user = creatorClientIdentity()) =>
    ['creator-characters', user, 'cover', id] as const,
  preset: (id: string, user = creatorClientIdentity()) =>
    ['creator-characters', user, 'preset', id] as const,
};

export function useCreatorPresetDetailQuery(id: CreatorPresetId | null) {
  return useQuery({
    queryKey: creatorCharacterKeys.preset(id ?? ''),
    queryFn: async ({ signal }) => {
      const data = CreatorPresetDetailDataSchema.parse(
        await apiClient<CreatorPresetDetailData>(
          `/api/creator/presets/${encodeURIComponent(id!)}`,
          { signal }
        )
      );
      if (data.preset.id !== id) throw new Error('预设详情未正确加载，请重试。');
      return data;
    },
    enabled: Boolean(id),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useCreatorCharactersQuery() {
  return useQuery({
    queryKey: creatorCharacterKeys.list(),
    queryFn: ({ signal }) =>
      apiClient<ListCreatorCharactersData>('/api/creator/characters', { signal }),
    staleTime: 30_000,
  });
}

export function useCreatorCharacterQuery(id: string | undefined) {
  return useQuery({
    queryKey: creatorCharacterKeys.detail(id ?? ''),
    queryFn: ({ signal }) =>
      apiClient<GetCreatorCharacterData>(`/api/creator/characters/${encodeURIComponent(id!)}`, {
        signal,
      }),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export function useSaveCreatorCharacterMutation() {
  const client = useQueryClient();
  const identity = creatorClientIdentity();
  return useMutation({
    retry: false,
    mutationFn: async (
      input:
        | { id: string; body: SaveCreatorCharacterRequest }
        | { body: CreateCreatorCharacterRequest; id?: undefined }
    ) => {
      const body = input.id
        ? SaveCreatorCharacterSchema.parse(input.body)
        : CreateCreatorCharacterSchema.parse(input.body);
      return apiClient<GetCreatorCharacterData>(
        input.id
          ? `/api/creator/characters/${encodeURIComponent(input.id)}`
          : '/api/creator/characters',
        {
          method: input.id ? 'PATCH' : 'POST',
          body: JSON.stringify(body),
          timeoutMs: 30_000,
        }
      );
    },
    onSuccess: (data) => {
      client.setQueryData(creatorCharacterKeys.detail(data.character.id, identity), data);
      void client.invalidateQueries({ queryKey: creatorCharacterKeys.list(identity) });
    },
  });
}

export function usePublishCreatorCharacterMutation() {
  const client = useQueryClient();
  const identity = creatorClientIdentity();
  return useMutation({
    retry: false,
    mutationFn: ({ id, body }: { id: string; body: PublishCreatorCharacterRequest }) =>
      apiClient<GetCreatorCharacterData>(
        `/api/creator/characters/${encodeURIComponent(id)}/publish`,
        {
          method: 'POST',
          body: JSON.stringify(PublishCreatorCharacterSchema.parse(body)),
          timeoutMs: 30_000,
        }
      ),
    onSuccess: (data) => {
      client.setQueryData(creatorCharacterKeys.detail(data.character.id, identity), data);
      void client.invalidateQueries({ queryKey: creatorCharacterKeys.list(identity) });
    },
  });
}

export function useSetCreatorVisibilityMutation() {
  const client = useQueryClient();
  const identity = creatorClientIdentity();
  return useMutation({
    retry: false,
    mutationFn: ({ id, body }: { id: string; body: SetCreatorVisibilityRequest }) =>
      apiClient<GetCreatorCharacterData>(
        `/api/creator/characters/${encodeURIComponent(id)}/visibility`,
        {
          method: 'PUT',
          body: JSON.stringify(SetCreatorVisibilitySchema.parse(body)),
          timeoutMs: 30_000,
        }
      ),
    onSuccess: (data) => {
      client.setQueryData(creatorCharacterKeys.detail(data.character.id, identity), data);
      void client.invalidateQueries({ queryKey: creatorCharacterKeys.list(identity) });
      void client.invalidateQueries({ queryKey: ['characters'] });
      void client.invalidateQueries({ queryKey: ['favorites'] });
    },
  });
}

export function useCreatorCoverQuery(id: string | null | undefined) {
  return useQuery({
    queryKey: creatorCharacterKeys.cover(id ?? ''),
    queryFn: async ({ signal }) => {
      const data = await apiClient<CreatorCoverData>(
        `/api/creator/covers/${encodeURIComponent(id!)}`,
        { signal }
      );
      return { asset: CreatorCoverAssetSchema.parse(data.asset) };
    },
    enabled: Boolean(id),
    // Signed image URLs need refreshing even when the persistent asset ID stays unchanged.
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });
}

export function useCreateCreatorCoverMutation() {
  const client = useQueryClient();
  const identity = creatorClientIdentity();
  return useMutation({
    retry: false,
    mutationFn: async (body: CreatorCoverRequest) => {
      const data = await apiClient<CreatorCoverData>('/api/creator/covers', {
        method: 'POST',
        body: JSON.stringify(CreatorCoverRequestSchema.parse(body)),
        timeoutMs: 60_000,
      });
      return { asset: CreatorCoverAssetSchema.parse(data.asset) };
    },
    onSuccess: (data) =>
      client.setQueryData(creatorCharacterKeys.cover(data.asset.id, identity), data),
  });
}

interface PolishInput {
  body: CreatorPolishRequest;
  signal: AbortSignal;
  onText: (text: string) => void;
}

/** Streaming stays in the API layer. A lost terminal event preserves all received text for adoption. */
export async function streamCreatorPolish({ body, signal, onText }: PolishInput): Promise<string> {
  const validated = CreatorPolishRequestSchema.parse(body);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error('润色等待较久，已有内容已保留。')),
    190_000
  );
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const initData = getRawInitData();
  if (initData) headers.set(INIT_DATA_HEADER, initData);
  try {
    const response = await fetch(`${API_URL}/api/creator/polish`, {
      method: 'POST',
      headers,
      body: JSON.stringify(validated),
      signal: controller.signal,
    });
    if (!response.ok)
      throw toApiClientError(response.status, await response.json().catch(() => null));
    if (!response.body) throw new Error('未收到润色内容，请重试。原稿已保留。');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let done = false;
    const consume = (line: string) => {
      if (!line.trim()) return;
      const event = CreatorPolishEventSchema.parse(JSON.parse(line));
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'done') done = true;
      if (event.type === 'delta') {
        text += event.text;
        onText(text);
      }
    };
    try {
      while (!done) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        let boundary: number;
        while ((boundary = buffer.indexOf('\n')) >= 0) {
          consume(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 1);
        }
        if (chunk.done) {
          consume(buffer);
          break;
        }
      }
      if (!done || !text.trim())
        throw new Error('这次润色未完整完成。已有内容仍可采用，原稿已保留。');
      return text;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export function useCreatorPolishMutation() {
  return useMutation({ mutationFn: streamCreatorPolish, retry: false });
}
