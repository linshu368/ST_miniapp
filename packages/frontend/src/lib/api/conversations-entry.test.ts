import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClientProvider } from '@tanstack/react-query';
import type { GetConversationData } from '@miniapp/shared';

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
import { conversationDetailQueryOptions, conversationKeys } from './conversations';
import { mergeChatHistory, historyPageCursor } from '@/hooks/use-chat-history';
import {
  useConversationGroups,
  useConversationPages,
  conversationListKeys,
} from './conversation-folders';
import { useConversationView } from '@/components/conversations/use-conversation-view';

function conversation(id: string, title = '已确认会话'): GetConversationData {
  return {
    session: {
      id,
      character_id: 'fixture-character',
      title,
      last_message_at: null,
      last_message_preview: null,
      message_count: 0,
      pinned_at: null,
      created_at: '2026-11-12T00:00:00Z',
      updated_at: '2026-11-12T00:00:00Z',
    },
    messages: [],
    has_more: false,
  };
}

let client: QueryClient;
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.mocked(apiClient).mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  client.clear();
});

function observe(id: string, created?: GetConversationData) {
  const observer = new QueryObserver(client, conversationDetailQueryOptions(id, created));
  cleanups.push(observer.subscribe(() => {}));
  return observer;
}

describe('visible conversation page scheduling', () => {
  it.each([503, 404, 500])(
    'only degrades agreed unavailable status %s without rewriting preference',
    (status) => {
      const setItem = vi.fn();
      // Model the terminal state of a mounted query, not a new SSR retry-on-mount.
      client.setDefaultOptions({ queries: { retry: false, retryOnMount: false } });
      vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem } });
      const groups = client
        .getQueryCache()
        .build(client, { queryKey: conversationListKeys.groups('all') });
      groups.setState({
        error: new ApiClientError('Synthetic read failure', status),
        status: 'error',
        fetchStatus: 'idle',
      });
      const saved = conversation('saved').session;
      client.setQueryData(conversationListKeys.pages({ folder: 'all' }), {
        pages: [{ sessions: [saved], total: 1 }],
        pageParams: [0],
      });
      let view!: ReturnType<typeof useConversationView>;
      function Probe() {
        view = useConversationView();
        return null;
      }
      renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)));
      expect(view.grouped).toBe(status === 500);
      expect(view.sessions).toEqual([saved]);
      expect(setItem).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  );
  it.each(['groups', 'pages'] as const)(
    'reserves critical for the first %s page and propagates cancellation',
    async (kind) => {
      let first!: () => Promise<unknown>;
      let next!: () => Promise<unknown>;
      function Probe() {
        const groups = useConversationGroups('all', kind === 'groups');
        const pages = useConversationPages({ folder: 'all' }, kind === 'pages');
        const query = kind === 'groups' ? groups : pages;
        first = () => query.refetch();
        next = () => query.fetchNextPage();
        return null;
      }
      renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)));
      const rows = Array.from({ length: 20 }, (_, i) => conversation(String(i)).session);
      vi.mocked(apiClient).mockResolvedValue({ total: 21, sessions: rows, groups: rows });
      await first();
      if (kind === 'groups')
        expect(apiClient).toHaveBeenLastCalledWith(
          expect.any(String),
          expect.objectContaining({ transportRetry: false })
        );
      expect(apiClient).toHaveBeenLastCalledWith(
        expect.stringContaining('offset=0'),
        expect.objectContaining({ queuePriority: 'critical', signal: expect.any(AbortSignal) })
      );
      await next();
      expect(apiClient).toHaveBeenLastCalledWith(
        expect.stringContaining('offset=20'),
        expect.objectContaining({ queuePriority: 'normal', signal: expect.any(AbortSignal) })
      );
      let signal: AbortSignal | undefined;
      vi.mocked(apiClient).mockImplementation((_path, options) => {
        signal = options?.signal ?? undefined;
        return new Promise(() => {});
      });
      const refetch = first();
      await vi.waitFor(() => expect(signal).toBeDefined());
      await client.cancelQueries({ queryKey: conversationKeys.lists });
      expect(signal?.aborted).toBe(true);
      await refetch;
    }
  );
});

describe('confirmed conversation creation cache', () => {
  function message(turn: number, revision = 0, content = 'fixture') {
    return {
      id: `m-${turn}-${revision}`,
      session_id: 'existing',
      turn_index: turn,
      revision,
      role: 'assistant' as const,
      content,
      status: 'complete' as const,
      error_code: null,
      finish_reason: 'stop',
      model_id: null,
      created_at: '2026-11-23T00:00:00Z',
    };
  }

  it('keeps loaded history without duplicate rows and replaces regenerated turns', () => {
    const old = [message(1), message(2), message(3)];
    const latest = [message(2, 1, 'new revision'), message(3), message(4)];
    const merged = mergeChatHistory(old, latest);
    expect(merged.map((item) => item.turn_index)).toEqual([1, 2, 3, 4]);
    expect(merged[1]?.content).toBe('new revision');
    expect(mergeChatHistory(merged, [message(2)])[1]?.revision).toBe(1);
  });

  it('fills a multi-device gap before paging past already loaded older history', () => {
    const older = [message(1), message(2)];
    const newer = [message(10), message(11)];
    const merged = mergeChatHistory(older, newer);
    expect(historyPageCursor(merged)).toBe(10);
    const filled = mergeChatHistory(
      merged,
      Array.from({ length: 7 }, (_, i) => message(i + 3))
    );
    expect(historyPageCursor(filled)).toBe(1);
    expect(filled).toHaveLength(11);
  });

  it('requests twenty messages for an uncached entry without a second query key', async () => {
    vi.mocked(apiClient).mockResolvedValue(conversation('fresh'));
    const observer = observe('fresh');
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
    expect(apiClient).toHaveBeenCalledExactlyOnceWith(
      '/api/v1/conversations/fresh?limit=20&read_purpose=entry',
      expect.objectContaining({ totalTimeoutMs: 10_000, queuePriority: 'critical' })
    );
  });
  it('does not read the same confirmed creation again, including a query-key transition', async () => {
    const data = conversation('created');
    client.setQueryData(conversationKeys.detail('created'), data);
    const confirmed = client.getQueryData<GetConversationData>(conversationKeys.detail('created'))!;
    const observer = new QueryObserver(client, conversationDetailQueryOptions(undefined));
    cleanups.push(observer.subscribe(() => {}));
    observer.setOptions(conversationDetailQueryOptions('created', confirmed));
    await Promise.resolve();
    expect(observer.getCurrentResult().data).toBe(confirmed);
    expect(observer.getCurrentResult().fetchStatus).toBe('idle');
    expect(apiClient).not.toHaveBeenCalled();
  });

  it('still refreshes an existing conversation on entry', async () => {
    client.setQueryData(conversationKeys.detail('existing'), conversation('existing', '旧标题'));
    vi.mocked(apiClient).mockResolvedValue(conversation('existing', '服务端新标题'));
    const observer = observe('existing');
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().data?.session.title).toBe('服务端新标题')
    );
    expect(apiClient).toHaveBeenCalledOnce();
  });

  it('can consume the entry exemption without a duplicate GET and still refresh on focus', async () => {
    client.setQueryData(conversationKeys.detail('created'), conversation('created'));
    const confirmed = client.getQueryData<GetConversationData>(conversationKeys.detail('created'))!;
    const observer = observe('created', confirmed);
    observer.setOptions(conversationDetailQueryOptions('created'));
    expect(observer.getCurrentResult().isStale).toBe(true);
    expect(apiClient).not.toHaveBeenCalled();

    vi.mocked(apiClient).mockResolvedValue(conversation('created', '其他设备更新'));
    client
      .getQueryCache()
      .find({ queryKey: conversationKeys.detail('created') })!
      .onFocus();
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().data?.session.title).toBe('其他设备更新')
    );
    expect(apiClient).toHaveBeenCalledOnce();
  });

  it('does not reuse one creation response for another conversation identity', async () => {
    client.setQueryData(conversationKeys.detail('existing'), conversation('existing'));
    vi.mocked(apiClient).mockResolvedValue(conversation('existing', '权威状态'));
    const observer = observe('existing', conversation('created'));
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().data?.session.title).toBe('权威状态')
    );
    expect(apiClient).toHaveBeenCalledWith(
      '/api/v1/conversations/existing?limit=20&read_purpose=refresh',
      expect.objectContaining({ queuePriority: 'critical' })
    );
  });

  it('refreshes explicitly invalidated creation data instead of retaining it forever', async () => {
    client.setQueryData(conversationKeys.detail('created'), conversation('created'));
    const confirmed = client.getQueryData<GetConversationData>(conversationKeys.detail('created'))!;
    const observer = observe('created', confirmed);
    vi.mocked(apiClient).mockResolvedValue(conversation('created', '更新后'));
    await client.invalidateQueries({ queryKey: conversationKeys.detail('created'), exact: true });
    expect(apiClient).toHaveBeenCalledOnce();
    expect(observer.getCurrentResult().data?.session.title).toBe('更新后');
  });

  it('ends the exemption after another cache update, even if the old creation identity is passed', async () => {
    client.setQueryData(conversationKeys.detail('created'), conversation('created'));
    const confirmed = client.getQueryData<GetConversationData>(conversationKeys.detail('created'))!;
    client.setQueryData(conversationKeys.detail('created'), conversation('created', '本地更新'));
    vi.mocked(apiClient).mockResolvedValue(conversation('created', '最新权威状态'));
    const observer = observe('created', confirmed);
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().data?.session.title).toBe('最新权威状态')
    );
    expect(apiClient).toHaveBeenCalledOnce();
  });
});
