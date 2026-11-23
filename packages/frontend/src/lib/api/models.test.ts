import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider, MutationObserver } from '@tanstack/react-query';
import type { GetModelCatalogData } from '@miniapp/shared';
import {
  applySelectedModelToCatalog,
  modelCatalogKeys,
  useSelectModelMutation,
  useModelCatalogQuery,
} from './models';
import { generationConfigKeys } from './generation-config';
import { hasPendingChatPreferences } from '@/hooks/use-chat-preference-guard';
vi.mock('./client', () => ({ apiClient: vi.fn() }));
vi.mock('../telegram/auth', () => ({ getRawInitData: () => null }));
vi.mock('../telegram/user', () => ({ parseTelegramUser: () => ({ id: 1 }) }));
import { apiClient } from './client';
import { MODEL_CATALOG_STALE_TIME_MS, shouldRefreshModelCatalog } from './model-cache-policy';

const catalog: GetModelCatalogData = {
  catalog: {
    default_model_id: 'flash',
    tiers: [
      {
        key: 'light',
        label: '轻量',
        color: '#ffffff',
        cost_hint: '低消耗',
        sort_order: 0,
        models: [
          {
            id: 'flash',
            display_name: 'Flash',
            tagline: '快',
            is_free: true,
            sort_order: 0,
          },
          {
            id: 'pro',
            display_name: 'Pro',
            tagline: '强',
            is_free: false,
            sort_order: 1,
          },
        ],
      },
    ],
  },
  selected_model_id: 'flash',
  selected_openrouter_model_id: 'google/gemini-flash',
  catalog_version: 1,
};

let client: QueryClient;
beforeEach(() => {
  vi.mocked(apiClient).mockReset();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(() => client.clear());

function selectMutation() {
  let mutation!: ReturnType<typeof useSelectModelMutation>;
  function Probe() {
    mutation = useSelectModelMutation('card');
    return null;
  }
  renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)));
  return mutation;
}

describe('confirmed chat model selection and write guard', () => {
  it('cancels an old catalog read without persisting its late result over a confirmed selection', async () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
    vi.stubGlobal('window', { localStorage: storage });
    try {
      const key = modelCatalogKeys.context(1, 'card');
      client.setQueryData(key, catalog);
      let query!: ReturnType<typeof useModelCatalogQuery>;
      function Probe() {
        query = useModelCatalogQuery({ enabled: false, characterId: 'card' });
        return null;
      }
      renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)));
      let finish!: (value: GetModelCatalogData) => void;
      let signal: AbortSignal | undefined;
      vi.mocked(apiClient).mockImplementation((_path, options) => {
        signal = options?.signal ?? undefined;
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      const pending = query.refetch();
      await vi.waitFor(() => expect(signal).toBeDefined());
      await client.cancelQueries({ queryKey: key });
      expect(signal?.aborted).toBe(true);
      client.setQueryData(key, { ...catalog, selected_model_id: 'pro' });
      finish(catalog);
      await pending;
      await Promise.resolve();
      await Promise.resolve();
      expect(client.getQueryData<GetModelCatalogData>(key)?.selected_model_id).toBe('pro');
      expect(storage.setItem).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('keeps the old model until the server confirms and guards the actual pending write', async () => {
    const key = modelCatalogKeys.context(1, 'card');
    client.setQueryData(key, catalog);
    let release!: (value: { model_id: string; openrouter_model_id: string }) => void;
    vi.mocked(apiClient).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const mutation = selectMutation();
    const pending = mutation.mutateAsync({ model_id: 'pro' });
    await vi.waitFor(() => expect(apiClient).toHaveBeenCalledOnce());
    expect(hasPendingChatPreferences(client)).toBe(true);
    expect(client.getQueryData<GetModelCatalogData>(key)?.selected_model_id).toBe('flash');
    release({ model_id: 'pro', openrouter_model_id: 'google/gemini-pro' });
    await pending;
    expect(client.getQueryData<GetModelCatalogData>(key)?.selected_model_id).toBe('pro');
    expect(hasPendingChatPreferences(client)).toBe(false);
    expect(apiClient).toHaveBeenCalledWith(
      '/api/v1/models/select',
      expect.objectContaining({ transportRetry: false, totalTimeoutMs: 10_000 })
    );
  });

  it('retains the old display and does not repeat a failed model POST', async () => {
    const key = modelCatalogKeys.context(1, 'card');
    client.setQueryData(key, catalog);
    vi.mocked(apiClient).mockRejectedValue(new Error('fixture selection rejected'));
    await expect(selectMutation().mutateAsync({ model_id: 'pro' })).rejects.toThrow(
      'fixture selection rejected'
    );
    expect(apiClient).toHaveBeenCalledOnce();
    expect(client.getQueryData<GetModelCatalogData>(key)?.selected_model_id).toBe('flash');
    expect(hasPendingChatPreferences(client)).toBe(false);
  });

  it('serializes model saves from separate mounted controls in the same QueryClient', async () => {
    client.setQueryData(modelCatalogKeys.context(1, 'card'), catalog);
    let release!: (value: { model_id: string; openrouter_model_id: string }) => void;
    vi.mocked(apiClient)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      )
      .mockResolvedValueOnce({ model_id: 'flash', openrouter_model_id: 'google/gemini-flash' });
    const first = selectMutation().mutateAsync({ model_id: 'pro' });
    const second = selectMutation().mutateAsync({ model_id: 'flash' });
    await vi.waitFor(() => expect(apiClient).toHaveBeenCalledOnce());
    expect(client.isMutating({ mutationKey: modelCatalogKeys.select })).toBe(2);
    release({ model_id: 'pro', openrouter_model_id: 'google/gemini-pro' });
    await Promise.all([first, second]);
    expect(apiClient).toHaveBeenCalledTimes(2);
    expect(
      client.getQueryData<GetModelCatalogData>(modelCatalogKeys.context(1, 'card'))
        ?.selected_model_id
    ).toBe('flash');
  });

  it('guards only submitted preference writes, not cached data or other mutations', async () => {
    client.setQueryData(generationConfigKeys.detail, {
      config: { pref_custom_instructions: 'saved' },
    });
    expect(hasPendingChatPreferences(client)).toBe(false);
    let finish!: () => void;
    const other = new MutationObserver(client, {
      mutationKey: ['favorite'],
      mutationFn: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    const unrelated = other.mutate();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(hasPendingChatPreferences(client)).toBe(false);
    finish();
    await unrelated;
    let confirm!: () => void;
    const patch = new MutationObserver(client, {
      mutationKey: generationConfigKeys.patch,
      mutationFn: () =>
        new Promise<void>((resolve) => {
          confirm = resolve;
        }),
    });
    const submitted = patch.mutate();
    await vi.waitFor(() => expect(confirm).toBeTypeOf('function'));
    expect(hasPendingChatPreferences(client)).toBe(true);
    confirm();
    await submitted;
    expect(hasPendingChatPreferences(client)).toBe(false);
  });
});

describe('model catalog refresh policy', () => {
  it('keeps creator/self prices separate by user and character', () => {
    expect(modelCatalogKeys.context(1, 'own-card')).not.toEqual(
      modelCatalogKeys.context(1, 'another-card')
    );
    expect(modelCatalogKeys.context(1, 'own-card')).not.toEqual(
      modelCatalogKeys.context(2, 'own-card')
    );
    expect(modelCatalogKeys.context(1)).not.toEqual(modelCatalogKeys.context(1, 'own-card'));
    expect(modelCatalogKeys.context(1, 'own-card').slice(0, 1)).toEqual(modelCatalogKeys.detail);
  });
  it('refreshes missing and older-than-five-minute data only', () => {
    const now = 1_000_000;
    expect(shouldRefreshModelCatalog(0, now)).toBe(true);
    expect(shouldRefreshModelCatalog(now - MODEL_CATALOG_STALE_TIME_MS, now)).toBe(false);
    expect(shouldRefreshModelCatalog(now - MODEL_CATALOG_STALE_TIME_MS - 1, now)).toBe(true);
  });
});

describe('applySelectedModelToCatalog', () => {
  it('leaves undefined catalogs untouched', () => {
    expect(applySelectedModelToCatalog(undefined, { model_id: 'pro' })).toBeUndefined();
  });

  it('optimistically switches selected_model_id without requiring the provider id', () => {
    const next = applySelectedModelToCatalog(catalog, { model_id: 'pro' });
    expect(next).toEqual({
      ...catalog,
      selected_model_id: 'pro',
    });
  });

  it('fills in the provider id after the select response lands', () => {
    const next = applySelectedModelToCatalog(catalog, {
      model_id: 'pro',
      openrouter_model_id: 'google/gemini-pro',
    });
    expect(next).toEqual({
      ...catalog,
      selected_model_id: 'pro',
      selected_openrouter_model_id: 'google/gemini-pro',
    });
  });

  it('returns the same object when the selection is already applied', () => {
    expect(applySelectedModelToCatalog(catalog, { model_id: 'flash' })).toBe(catalog);
  });
});
