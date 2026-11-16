import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LobbyRecommendationData } from '@miniapp/shared';
const state = vi.hoisted(() => ({ scope: 'fixture-1', sequence: 0, remember: vi.fn() }));
vi.mock('@/lib/lobby-recommendation-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/lobby-recommendation-state')>()),
  lobbyViewerScope: () => state.scope,
  createLobbyRequestId: () =>
    `10000000-0000-4000-8000-${String(++state.sequence).padStart(12, '0')}`,
  rememberLobbyRecommendation: state.remember,
}));
vi.mock('./characters', () => ({ readLegacyHeadCards: vi.fn() }));
vi.mock('./client', () => ({
  apiClient: vi.fn(),
  ApiClientError: class extends Error {
    constructor(
      message: string,
      readonly status: number
    ) {
      super(message);
    }
  },
}));
import { apiClient, ApiClientError } from './client';
import {
  requestRecommendation,
  ENTRY_RECOMMENDATION_TIMEOUT_MS,
} from './lobby-recommendation-request';
import { useLobbyRecommendationChange } from './lobby-recommendation-change';
import { useLobbyRecommendation } from './lobby-recommendations';
const body = { action: 'open' as const, request_id: '10000000-0000-4000-8000-000000000001' };
const batch: LobbyRecommendationData = {
  enabled: false,
  degraded: false,
  batch_id: null,
  generated_at: null,
  expires_at: null,
  previous_batch_id: null,
  character_ids: [],
  head_ids: [],
  head_cards: [],
};
let client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(apiClient).mockReset();
  state.scope = 'fixture-1';
  state.sequence = 0;
  state.remember.mockReset();
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
});
afterEach(() => {
  client.clear();
  vi.useRealTimers();
});
function stall() {
  vi.mocked(apiClient).mockImplementation(
    (_path, options) =>
      new Promise((_, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
  );
}
function manual() {
  let result!: ReturnType<typeof useLobbyRecommendationChange>;
  const accepted = vi.fn();
  function Probe() {
    result = useLobbyRecommendationChange(state.scope, ['recommendation', 'fixture-1'], accepted);
    return null;
  }
  renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)));
  return { result, accepted };
}
describe('recommendation intent budgets', () => {
  it('wires the actual automatic entry query to the short budget', async () => {
    stall();
    function Probe() {
      useLobbyRecommendation({ enabled: true });
      return null;
    }
    renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)));
    const query = client.getQueryCache().find({ queryKey: ['lobby-recommendation', 'fixture-1'] })!;
    const read = query.fetch();
    const rejected = expect(read).rejects.toThrow();
    expect(vi.mocked(apiClient).mock.calls[0]?.[1]?.timeoutMs).toBe(1500);
    await vi.advanceTimersByTimeAsync(1500);
    await rejected;
  });
  it('aborts automatic entry after 1500ms including waiting for a body', async () => {
    stall();
    const read = requestRecommendation(body, undefined, ENTRY_RECOMMENDATION_TIMEOUT_MS);
    const rejected = expect(read).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1499);
    expect(vi.mocked(apiClient).mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(vi.mocked(apiClient).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not reset entry deadline for an old-server 400 compatibility attempt', async () => {
    stall();
    const pending = vi.mocked(apiClient).getMockImplementation()!;
    vi.mocked(apiClient)
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) =>
            setTimeout(() => reject(new ApiClientError('old schema', 400)), 1000)
          )
      )
      .mockImplementation(pending);
    const read = requestRecommendation(body, undefined, 1500);
    const rejected = expect(read).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1000);
    expect(apiClient).toHaveBeenCalledTimes(2);
    const first = vi.mocked(apiClient).mock.calls[0]?.[1];
    const second = vi.mocked(apiClient).mock.calls[1]?.[1];
    expect(first?.signal).toBe(second?.signal);
    expect(JSON.parse(second?.body as string)).not.toHaveProperty('include_head_cards');
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
  });
  it('propagates caller cancellation without an extra attempt', async () => {
    stall();
    const controller = new AbortController();
    const read = requestRecommendation(body, controller.signal, 1500);
    const rejected = expect(read).rejects.toThrow();
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await rejected;
    expect(apiClient).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a transport success arriving after an ignored deadline', async () => {
    let resolve!: (value: LobbyRecommendationData) => void;
    vi.mocked(apiClient).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const read = requestRecommendation(body, undefined, 1500);
    const rejected = expect(read).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1500);
    resolve(batch);
    await rejected;
  });
  it('retains the 5000ms manual budget even when refresh without a batch uses action=open', async () => {
    stall();
    const { result } = manual();
    const read = result.refresh();
    await vi.advanceTimersByTimeAsync(1500);
    const request = vi.mocked(apiClient).mock.calls[0]?.[1];
    expect(request?.timeoutMs).toBe(5000);
    expect(request?.signal?.aborted).toBe(false);
    expect(JSON.parse(request?.body as string).action).toBe('open');
    await vi.advanceTimersByTimeAsync(3500);
    expect(await read).toBeNull();
  });
  it('prevents duplicate manual intent, keeps the failed UUID and ignores a changed viewer', async () => {
    vi.mocked(apiClient).mockRejectedValueOnce(new Error('lost response')).mockResolvedValue(batch);
    const { result } = manual();
    expect(await result.refresh()).toBeNull();
    const original = JSON.parse(vi.mocked(apiClient).mock.calls[0]?.[1]?.body as string).request_id;
    expect(await result.refresh()).toEqual(batch);
    expect(JSON.parse(vi.mocked(apiClient).mock.calls[1]?.[1]?.body as string).request_id).toBe(
      original
    );
    let resolve!: (value: LobbyRecommendationData) => void;
    vi.mocked(apiClient).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const read = result.refresh();
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    expect(await result.refresh()).toBeNull();
    state.scope = 'fixture-2';
    resolve(batch);
    expect(await read).toBeNull();
    expect(client.getQueryData(['recommendation', 'fixture-2'])).toBeUndefined();
  });
});
