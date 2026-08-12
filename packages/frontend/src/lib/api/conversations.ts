'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateConversationData,
  DeleteConversationData,
  GetConversationData,
  ListConversationsData,
  RenameConversationData,
} from '@miniapp/shared';
import { apiClient } from './client';

export const conversationKeys = {
  all: ['conversations'] as const,
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
 * 这里是落库态的唯一真相：流式期间的临时文本由聊天页用组件 state 叠在它之上，
 * 不写进缓存——逐帧 setQueryData 会让所有订阅方重渲染，且流被中断后
 * 缓存里会留下一条永远不会收口的假消息。
 */
export function useConversationQuery(sessionId: string | undefined) {
  return useQuery<GetConversationData>({
    queryKey: conversationKeys.detail(sessionId ?? ''),
    enabled: Boolean(sessionId),
    queryFn: async () => {
      if (!sessionId) throw new Error('session id is required');
      return apiClient<GetConversationData>(
        `/api/v1/conversations/${encodeURIComponent(sessionId)}`
      );
    },
    staleTime: 0,
    // 库里还有一条没收口的 assistant 消息时轮询到它收口为止。
    // 两种情况会走到这里：本端点了停止（后端不因客户端断开而终止，仍会写完），
    // 以及另一端正在生成。不轮询的话这条消息会一直停在半截，且此时发新消息必吃 409。
    refetchInterval: (query) =>
      query.state.data?.messages.some((message) => message.status === 'streaming') ? 1_500 : false,
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
      void queryClient.invalidateQueries({ queryKey: conversationKeys.list(characterId) });
    },
  });
}

export function useRenameConversationMutation(characterId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    /** title 传 null 表示清空为自动命名 */
    mutationFn: async (input: { sessionId: string; title: string | null }) =>
      apiClient<RenameConversationData>(
        `/api/v1/conversations/${encodeURIComponent(input.sessionId)}`,
        { method: 'PATCH', body: JSON.stringify({ title: input.title }) }
      ),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: conversationKeys.list(characterId) });
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.detail(data.session.id),
      });
    },
  });
}

export function useDeleteConversationMutation(characterId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId: string) =>
      apiClient<DeleteConversationData>(`/api/v1/conversations/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      }),
    onSuccess: (data) => {
      queryClient.removeQueries({ queryKey: conversationKeys.detail(data.id) });
      void queryClient.invalidateQueries({ queryKey: conversationKeys.list(characterId) });
    },
  });
}

/**
 * 会话标题：用户没重命名过时按首条用户消息截断。
 * 契约里 title 为 null 就是这个意思，兜底文案由前端决定。
 */
export function resolveSessionTitle(
  title: string | null,
  preview: string | null,
  fallback = '新的对话'
): string {
  const named = title?.trim();
  if (named) return named;

  const summary = preview?.trim().replace(/\s+/g, ' ');
  if (!summary) return fallback;
  return summary.length > 18 ? `${summary.slice(0, 18)}…` : summary;
}
