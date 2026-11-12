import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { GetConversationData } from '@miniapp/shared';

vi.mock('./client', () => ({ apiClient: vi.fn(), ApiClientError: class extends Error {} }));
import { apiClient } from './client';
import { conversationDetailQueryOptions, conversationKeys } from './conversations';

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

describe('confirmed conversation creation cache', () => {
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
      '/api/v1/conversations/existing',
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
