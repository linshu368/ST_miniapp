'use client';

import { useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DeleteSessionData,
  GetSessionsData,
  GetSessionDetailData,
  Message,
  PatchSessionData,
  PatchSessionRequest,
  PostMessageData,
  PostMessageRequest,
  PostOpenSessionData,
  PostOpenSessionRequest,
} from '@miniapp/shared';

import { apiClient, apiStreamClient } from './client';

// ==== Query Keys ====
export const sessionKeys = {
  all: ['sessions'] as const,
  lists: () => [...sessionKeys.all, 'list'] as const,
  detail: (id: string) => [...sessionKeys.all, 'detail', id] as const,
};

// ==== "她在打字" 订阅 ====
// 流式 chunk 抵达前需要 indicator；与 mutation 生命周期解耦
// 每次变更生成新的 ReadonlySet 快照，useSyncExternalStore 才能正确判定引用变化
const typingListeners = new Set<() => void>();
let typingSnapshot: ReadonlySet<string> = new Set();

function setTyping(sessionId: string, on: boolean) {
  const next = new Set(typingSnapshot);
  if (on) next.add(sessionId);
  else next.delete(sessionId);
  typingSnapshot = next;
  typingListeners.forEach((l) => l());
}

function getTypingSnapshot(): ReadonlySet<string> {
  return typingSnapshot;
}

function subscribeTyping(listener: () => void): () => void {
  typingListeners.add(listener);
  return () => {
    typingListeners.delete(listener);
  };
}

/** 订阅某个 session 的"她在打字"状态，供对话页 indicator 使用 */
export function useAssistantTyping(sessionId: string | undefined): boolean {
  const snap = useSyncExternalStore(subscribeTyping, getTypingSnapshot, getTypingSnapshot);
  return !!sessionId && snap.has(sessionId);
}

function newId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

// ==== 真实接口 fetch 函数（私有）====
async function fetchSessions(): Promise<GetSessionsData> {
  return apiClient<GetSessionsData>('/api/sessions');
}

async function fetchSessionDetail(id: string): Promise<GetSessionDetailData> {
  return apiClient<GetSessionDetailData>(`/api/sessions/${id}`);
}

async function postOpenSession(body: PostOpenSessionRequest): Promise<PostOpenSessionData> {
  return apiClient<PostOpenSessionData>('/api/sessions/open', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function postMessage(
  sessionId: string,
  body: PostMessageRequest,
  onChunk: (text: string) => void
): Promise<PostMessageData> {
  await apiStreamClient(
    `/api/sessions/${sessionId}/messages`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
    onChunk
  );
  // Return a dummy message since the real one will be fetched when we invalidate the queries
  return {
    message: {
      id: '',
      session_id: sessionId,
      role: 'user',
      content: body.content,
      created_at: new Date().toISOString(),
    },
  };
}

// ==== React Query hooks（业务层唯一入口）====

export function useSessionsQuery() {
  return useQuery<GetSessionsData>({
    queryKey: sessionKeys.lists(),
    queryFn: async () => {
      return fetchSessions();
    },
  });
}

export function useSessionQuery(sessionId: string | undefined) {
  return useQuery<GetSessionDetailData>({
    queryKey: sessionId ? sessionKeys.detail(sessionId) : sessionKeys.all,
    enabled: !!sessionId,
    queryFn: async () => {
      if (!sessionId) throw new Error('session id is required');
      return fetchSessionDetail(sessionId);
    },
  });
}

/** 为某个角色新建一个 session(永远新建,不复用现存 session)。 */
export function useOpenSessionForCharacter() {
  const qc = useQueryClient();

  return useMutation<PostOpenSessionData, Error, PostOpenSessionRequest, PostOpenSessionData>({
    mutationFn: async (body) => {
      return postOpenSession(body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: sessionKeys.lists() });
    },
  });
}

/** 发送消息。乐观更新 user 消息。 */
export function useSendMessageMutation(sessionId: string) {
  const qc = useQueryClient();

  return useMutation<PostMessageData, Error, PostMessageRequest>({
    mutationFn: async (body) => {
      const now = new Date().toISOString();
      const userMsg: Message = {
        id: newId('msg'),
        session_id: sessionId,
        role: 'user',
        content: body.content,
        created_at: now,
      };

      // 乐观：user 消息先落下
      qc.setQueryData<GetSessionDetailData>(sessionKeys.detail(sessionId), (prev) =>
        prev
          ? {
              session: {
                ...prev.session,
                messages: [...prev.session.messages, userMsg],
              },
            }
          : prev
      );

      // 流式读取 assistant 回复
      const tempAssistantId = newId('temp-msg');
      const tempAssistantMsg: Message = {
        id: tempAssistantId,
        session_id: sessionId,
        role: 'assistant',
        content: '',
        created_at: new Date().toISOString(),
      };

      // 乐观：推入空的 assistant 消息
      qc.setQueryData<GetSessionDetailData>(sessionKeys.detail(sessionId), (prev) =>
        prev
          ? {
              session: {
                ...prev.session,
                messages: [...prev.session.messages, tempAssistantMsg],
              },
            }
          : prev
      );

      setTyping(sessionId, true);

      let hasError = false;
      try {
        const result = await postMessage(sessionId, body, (chunkText) => {
          // 每次收到流式数据，更新缓存中临时 assistant 消息的内容
          qc.setQueryData<GetSessionDetailData>(sessionKeys.detail(sessionId), (prev) => {
            if (!prev) return prev;
            return {
              session: {
                ...prev.session,
                messages: prev.session.messages.map((m) =>
                  m.id === tempAssistantId ? { ...m, content: chunkText } : m
                ),
              },
            };
          });
        });
        return result;
      } catch (err) {
        hasError = true;
        throw err;
      } finally {
        setTyping(sessionId, false);

        // 检查临时 assistant 消息内容
        qc.setQueryData<GetSessionDetailData>(sessionKeys.detail(sessionId), (prev) => {
          if (!prev) return prev;
          const msgs = prev.session.messages;
          const tempMsg = msgs.find((m) => m.id === tempAssistantId);

          if (tempMsg) {
            if (!tempMsg.content) {
              // 如果为空，则替换为兜底提示（如果原意是从缓存移除再在别处显示兜底提示，此处通过改变内容来实现兜底展示）
              return {
                session: {
                  ...prev.session,
                  messages: msgs.map((m) =>
                    m.id === tempAssistantId ? { ...m, content: '请稍后重试' } : m
                  ),
                },
              };
            } else if (hasError) {
              // 如果已有部分内容且报错，则追加兜底提示
              return {
                session: {
                  ...prev.session,
                  messages: msgs.map((m) =>
                    m.id === tempAssistantId ? { ...m, content: `${m.content}\n\n[请稍后重试]` } : m
                  ),
                },
              };
            }
          }
          return prev;
        });
      }
    },
    onSettled: (data, error) => {
      // 如果失败，保留本地缓存的兜底提示，不强制刷新详情
      if (!error) {
        void qc.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
      }
      void qc.invalidateQueries({ queryKey: sessionKeys.lists() });
    },
  });
}

// ==== Session 修改 / 删除 mutations ====
// 乐观更新 list 缓存 + 调真后端；失败回滚到 onMutate 之前的快照。

export function useUpdateSessionMutation() {
  const qc = useQueryClient();
  return useMutation<
    PatchSessionData,
    Error,
    { sessionId: string; patch: PatchSessionRequest },
    { previousSessions: GetSessionsData | undefined }
  >({
    onMutate: async ({ sessionId, patch }) => {
      await qc.cancelQueries({ queryKey: sessionKeys.lists() });
      const previousSessions = qc.getQueryData<GetSessionsData>(sessionKeys.lists());

      qc.setQueryData<GetSessionsData>(sessionKeys.lists(), (prev) => {
        if (!prev) return prev;
        return {
          sessions: prev.sessions.map((s) => {
            if (s.id !== sessionId) return s;
            return {
              ...s,
              ...(patch.is_pinned !== undefined ? { is_pinned: patch.is_pinned } : {}),
              ...(patch.custom_name !== undefined
                ? patch.custom_name
                  ? { custom_name: patch.custom_name }
                  : { custom_name: undefined }
                : {}),
            };
          }),
        };
      });

      return { previousSessions };
    },
    mutationFn: async ({ sessionId, patch }) => {
      return apiClient<PatchSessionData>(`/api/sessions/${sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
    },
    onError: (err, variables, context) => {
      if (context?.previousSessions) {
        qc.setQueryData(sessionKeys.lists(), context.previousSessions);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: sessionKeys.lists() });
    },
  });
}

export function useDeleteSessionMutation() {
  const qc = useQueryClient();
  return useMutation<
    DeleteSessionData,
    Error,
    { sessionId: string },
    { previousSessions: GetSessionsData | undefined }
  >({
    onMutate: async ({ sessionId }) => {
      await qc.cancelQueries({ queryKey: sessionKeys.lists() });
      const previousSessions = qc.getQueryData<GetSessionsData>(sessionKeys.lists());

      qc.setQueryData<GetSessionsData>(sessionKeys.lists(), (prev) => {
        if (!prev) return prev;
        return { sessions: prev.sessions.filter((s) => s.id !== sessionId) };
      });

      return { previousSessions };
    },
    mutationFn: async ({ sessionId }) => {
      return apiClient<DeleteSessionData>(`/api/sessions/${sessionId}`, {
        method: 'DELETE',
      });
    },
    onError: (err, variables, context) => {
      if (context?.previousSessions) {
        qc.setQueryData(sessionKeys.lists(), context.previousSessions);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: sessionKeys.lists() });
    },
  });
}
