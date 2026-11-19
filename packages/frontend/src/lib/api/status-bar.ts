'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CharacterDraft,
  CharacterStatusBarData,
  ConversationStatusData,
  CreatorStatusBarDescribeData,
  CreatorStatusBarTemplateData,
  StatusBarItem,
  StatusBarTemplate,
} from '@miniapp/shared';
import { apiClient } from './client';

export const statusBarKeys = {
  all: ['status-bar'] as const,
  conversation: (sessionId: string) => [...statusBarKeys.all, 'conversation', sessionId] as const,
  character: (characterId: string) => [...statusBarKeys.all, 'character', characterId] as const,
};

const conversationUrl = (sessionId: string, suffix = '') =>
  `/api/conversations/${encodeURIComponent(sessionId)}/status${suffix}`;
const characterUrl = (characterId: string) =>
  `/api/characters/${encodeURIComponent(characterId)}/status-bar`;

/** 状态面板数据。后台在自动更新时每 2 秒再读一次，直到更新完。 */
export function useConversationStatusQuery(sessionId: string | null, enabled = true) {
  return useQuery<ConversationStatusData>({
    queryKey: statusBarKeys.conversation(sessionId ?? 'none'),
    enabled: enabled && Boolean(sessionId),
    queryFn: () => apiClient<ConversationStatusData>(conversationUrl(sessionId!)),
    staleTime: 30_000,
    refetchInterval: (query) => (query.state.data?.updating ? 2_000 : false),
  });
}

/** 手动更新（仅限 VIP）；服务端返回更新后的完整数据。 */
export function useRefreshConversationStatusMutation(sessionId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiClient<ConversationStatusData>(conversationUrl(sessionId!, '/refresh'), {
        method: 'POST',
        timeoutMs: 70_000,
      }),
    onSuccess: (data) => {
      if (sessionId) queryClient.setQueryData(statusBarKeys.conversation(sessionId), data);
    },
  });
}

export function useUndoConversationStatusMutation(sessionId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiClient<ConversationStatusData>(conversationUrl(sessionId!, '/undo'), { method: 'POST' }),
    onSuccess: (data) => {
      if (sessionId) queryClient.setQueryData(statusBarKeys.conversation(sessionId), data);
    },
  });
}

/** 工具箱：这张卡对这个玩家生效的状态栏（改过的或作者的）。 */
export function useCharacterStatusBarQuery(characterId: string, enabled = true) {
  return useQuery<CharacterStatusBarData>({
    queryKey: statusBarKeys.character(characterId),
    enabled,
    queryFn: () => apiClient<CharacterStatusBarData>(characterUrl(characterId)),
    staleTime: 60_000,
  });
}

/** 保存或恢复（template=null）后，聊天面板用的数据也要跟着刷新。 */
export function useSaveCharacterStatusBarMutation(characterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (template: StatusBarTemplate | null) =>
      template
        ? apiClient<CharacterStatusBarData>(characterUrl(characterId), {
            method: 'PUT',
            body: JSON.stringify({ template }),
          })
        : apiClient<CharacterStatusBarData>(characterUrl(characterId), { method: 'DELETE' }),
    onSuccess: (data) => {
      queryClient.setQueryData(statusBarKeys.character(characterId), data);
      void queryClient.invalidateQueries({ queryKey: [...statusBarKeys.all, 'conversation'] });
    },
  });
}

// ── 创作者建卡时的状态栏 AI ─────────────────────────────────────────────────

/** 后端每次调模型最多 90 秒、最多 3 次，前端等够 3 次再报失败。 */
const AI_TIMEOUT_MS = 290_000;

export function useCreatorStatusBarAi() {
  const generate = useMutation({
    mutationFn: (draft: CharacterDraft) =>
      apiClient<CreatorStatusBarTemplateData>('/api/creator/status-bar/generate', {
        method: 'POST',
        body: JSON.stringify({ draft }),
        timeoutMs: AI_TIMEOUT_MS,
      }),
  });
  const describe = useMutation({
    mutationFn: (input: { draft: CharacterDraft; item: StatusBarItem }) =>
      apiClient<CreatorStatusBarDescribeData>('/api/creator/status-bar/describe', {
        method: 'POST',
        body: JSON.stringify(input),
        timeoutMs: AI_TIMEOUT_MS,
      }),
  });
  const complete = useMutation({
    mutationFn: (input: { draft: CharacterDraft; template: StatusBarTemplate }) =>
      apiClient<CreatorStatusBarTemplateData>('/api/creator/status-bar/complete', {
        method: 'POST',
        body: JSON.stringify(input),
        timeoutMs: AI_TIMEOUT_MS,
      }),
  });
  const edit = useMutation({
    mutationFn: (input: {
      draft: CharacterDraft;
      template: StatusBarTemplate;
      instruction: string;
    }) =>
      apiClient<CreatorStatusBarTemplateData>('/api/creator/status-bar/edit', {
        method: 'POST',
        body: JSON.stringify(input),
        timeoutMs: AI_TIMEOUT_MS,
      }),
  });
  return { generate, describe, complete, edit };
}
