'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CancelConversationTurnData,
  CancelConversationTurnRequest,
  CreateConversationData,
  DeleteConversationData,
  GetConversationData,
  ListConversationsData,
  UpdateConversationData,
} from '@miniapp/shared';
import { apiClient } from './client';

export const conversationKeys = {
  all: ['conversations'] as const,
  /**
   * 所有列表的公共前缀。改一个会话会同时影响 /chats 的全量列表和角色内的按角色列表，
   * 只失效其中一条会让另一条留着旧顺序，所以写操作一律按这个前缀失效。
   * 它刻意不覆盖 detail：那会把每个打开着的会话都重新拉一遍。
   */
  lists: ['conversations', 'list'] as const,
  list: (characterId?: string) => ['conversations', 'list', characterId ?? 'all'] as const,
  detail: (sessionId: string) => ['conversations', 'detail', sessionId] as const,
};

/** 某个角色下的会话列表；不传 characterId 则是跨角色的全部会话 */
export function useConversationsQuery(characterId: string | undefined, enabled = true) {
  return useQuery<ListConversationsData>({
    queryKey: conversationKeys.list(characterId),
    enabled,
    queryFn: async () => {
      const search = new URLSearchParams();
      if (characterId) search.set('character_id', characterId);
      const query = search.toString();
      return apiClient<ListConversationsData>(`/api/v1/conversations${query ? `?${query}` : ''}`);
    },
    staleTime: 0,
  });
}

/**
 * 单个会话的消息。
 *
 * 这里是落库态的唯一真相：流式期间的临时文本由 use-conversation-turn 用组件 state 叠在它之上，
 * 不写进缓存——逐帧 setQueryData 会让所有订阅方重渲染，且流被中断后
 * 缓存里会留下一条永远不会收口的假消息。
 */
export function useConversationQuery(sessionId: string | undefined) {
  return useQuery<GetConversationData>({
    queryKey: conversationKeys.detail(sessionId ?? ''),
    enabled: Boolean(sessionId),
    queryFn: async () => {
      if (!sessionId) throw new Error('session id is required');
      return fetchConversationDetail(sessionId);
    },
    staleTime: 0,
    // 库里还有一条没收口的 assistant 消息时轮询到它收口为止。
    // 断流或另一端生成后仍以服务端终态为准；不能把浏览器 abort 当成取消成功。
    refetchInterval: (query) =>
      query.state.data?.messages.some((message) => message.status === 'streaming') ? 1_500 : false,
  });
}

/** 有限等待，供详情 query 与取消前精确定位当前 revision 复用。 */
export function fetchConversationDetail(
  sessionId: string,
  timeoutMs = 10_000
): Promise<GetConversationData> {
  return apiClient<GetConversationData>(`/api/v1/conversations/${encodeURIComponent(sessionId)}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export function useCancelConversationTurnMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: ({
      sessionId,
      assistantMessageId,
    }: {
      sessionId: string;
      assistantMessageId: string;
    }) => {
      const body: CancelConversationTurnRequest = { assistant_message_id: assistantMessageId };
      return apiClient<CancelConversationTurnData>(
        `/api/v1/conversations/${encodeURIComponent(sessionId)}/cancel`,
        { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }
      );
    },
    onSuccess: (data, { sessionId }) => {
      queryClient.setQueryData<GetConversationData>(
        conversationKeys.detail(sessionId),
        (current) =>
          current
            ? {
                ...current,
                messages: current.messages.map((message) =>
                  message.id === data.message.id ? data.message : message
                ),
              }
            : current
      );
      void queryClient.invalidateQueries({ queryKey: conversationKeys.detail(sessionId) });
    },
  });
}

/** 向前翻页。只取 turn_index 小于 beforeTurnIndex 的消息 */
export function fetchConversationPage(
  sessionId: string,
  beforeTurnIndex: number
): Promise<GetConversationData> {
  const search = new URLSearchParams({ before_turn_index: String(beforeTurnIndex) });
  return apiClient<GetConversationData>(
    `/api/v1/conversations/${encodeURIComponent(sessionId)}?${search.toString()}`
  );
}

export function useCreateConversationMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (characterId: string) =>
      apiClient<CreateConversationData>('/api/v1/conversations', {
        method: 'POST',
        body: JSON.stringify({ character_id: characterId }),
      }),
    onSuccess: (data, characterId) => {
      // 新会话立刻可读，省掉进页面后的第一次 GET
      queryClient.setQueryData<GetConversationData>(conversationKeys.detail(data.session.id), {
        session: data.session,
        messages: data.messages,
        has_more: false,
      });
      void queryClient.invalidateQueries({ queryKey: conversationKeys.lists });
    },
  });
}

/**
 * 重命名与置顶共用一条 PATCH。字段不传就是不改——title 的 null 已经被
 * 「恢复为当前角色名」占用，不能再兼任「不改」。
 */
export function useUpdateConversationMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    /** title 传 null 表示恢复为当前绑定角色的 name */
    mutationFn: async (input: { sessionId: string; title?: string | null; pinned?: boolean }) => {
      const { sessionId, ...patch } = input;
      return apiClient<UpdateConversationData>(
        `/api/v1/conversations/${encodeURIComponent(sessionId)}`,
        { method: 'PATCH', body: JSON.stringify(patch) }
      );
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: conversationKeys.lists });
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.detail(data.session.id),
      });
    },
  });
}

export function useDeleteConversationMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId: string) =>
      apiClient<DeleteConversationData>(`/api/v1/conversations/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      }),
    onSuccess: (data) => {
      queryClient.removeQueries({ queryKey: conversationKeys.detail(data.id) });
      void queryClient.invalidateQueries({ queryKey: conversationKeys.lists });
    },
  });
}

/** 顶栏、会话抽屉、历史列表统一只展示这么多字 */
export const SESSION_TITLE_DISPLAY_LENGTH = 7;
const DEFAULT_DISPLAY_TITLE = '新的对话';

/**
 * 会话标题展示：优先用已存 title，缺省时用 fallback（通常是角色名）。
 * 一律截到 SESSION_TITLE_DISPLAY_LENGTH 个字符；不再用消息预览当标题。
 */
export function resolveSessionTitle(
  title: string | null | undefined,
  fallback?: string | null
): string {
  const source = title?.trim() || fallback?.trim() || DEFAULT_DISPLAY_TITLE;
  const chars = Array.from(source);
  if (chars.length <= SESSION_TITLE_DISPLAY_LENGTH) return source;
  return chars.slice(0, SESSION_TITLE_DISPLAY_LENGTH).join('');
}
