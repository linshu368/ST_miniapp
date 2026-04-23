'use client';

import { useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  GetSessionsData,
  GetSessionDetailData,
  Message,
  PostMessageData,
  PostMessageRequest,
  PostOpenSessionData,
  PostOpenSessionRequest,
  SessionSummary,
} from '@miniapp/shared';

import { apiClient } from './client';
import { mockAssistantReplies, mockMessagesBySession, mockSessions } from '@/lib/mock-data/chat';
import { getMockCharacterDetail, mockCharacters } from '@/lib/mock-data/characters';

const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === '1';

// ==== Query Keys ====
export const sessionKeys = {
  all: ['sessions'] as const,
  lists: () => [...sessionKeys.all, 'list'] as const,
  detail: (id: string) => [...sessionKeys.all, 'detail', id] as const,
};

// ==== Mock 端内存状态 ====
// 维持在模块作用域，SPA 运行期持久；刷新会重置（可接受）
type MockState = {
  sessions: SessionSummary[];
  messagesBySession: Record<string, Message[]>;
};

const mockState: MockState = {
  sessions: [...mockSessions],
  messagesBySession: Object.fromEntries(
    Object.entries(mockMessagesBySession).map(([k, v]) => [k, [...v]])
  ),
};

function truncatePreview(content: string, max = 24): string {
  const one = content.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return one.slice(0, max) + '…';
}

function pickReply(): string {
  const pool = mockAssistantReplies;
  const fallback = '嗯。';
  if (pool.length === 0) return fallback;
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx] ?? fallback;
}

function randomDelayMs(): number {
  // 1.5s – 3s 随机延迟，呼应"她在"的呼吸节奏
  return 1500 + Math.random() * 1500;
}

// ==== "她在打字" 订阅 ====
// 独立于 mutation 生命周期：mock 下 user 消息已落，assistant 还在延迟中
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

async function postMessage(sessionId: string, body: PostMessageRequest): Promise<PostMessageData> {
  return apiClient<PostMessageData>(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
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

/** 打开（或新建）某个角色的会话。 */
export function useOpenSessionForCharacter() {
  const qc = useQueryClient();

  return useMutation<PostOpenSessionData, Error, PostOpenSessionRequest>({
    mutationFn: async (body) => {
      if (USE_MOCK) {
        const existing = mockState.sessions
          .filter((s) => s.character_id === body.character_id)
          .sort((a, b) => +new Date(b.last_message_at) - +new Date(a.last_message_at))[0];
        if (existing) {
          return { session_id: existing.id };
        }
        const detail = getMockCharacterDetail(body.character_id);
        const sessionId = newId('sess');
        const now = new Date().toISOString();
        const greeting = detail?.greeting ?? '……';
        const firstMessage: Message = {
          id: newId('msg'),
          session_id: sessionId,
          role: 'assistant',
          content: greeting,
          created_at: now,
        };
        mockState.messagesBySession[sessionId] = [firstMessage];
        mockState.sessions.unshift({
          id: sessionId,
          character_id: body.character_id,
          character_name: detail?.name ?? '',
          last_message_preview: truncatePreview(greeting),
          last_message_at: now,
        });
        return { session_id: sessionId };
      }
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

      if (USE_MOCK) {
        mockState.messagesBySession[sessionId] = [
          ...(mockState.messagesBySession[sessionId] ?? []),
          userMsg,
        ];
        // 更新 session 摘要
        mockState.sessions = mockState.sessions.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                last_message_preview: truncatePreview(body.content),
                last_message_at: now,
              }
            : s
        );
        void qc.invalidateQueries({ queryKey: sessionKeys.lists() });

        // 标记"她在打字"
        setTyping(sessionId, true);

        // 异步 mock 回复：1.5–3s 后落下
        setTimeout(() => {
          const replyContent = pickReply();
          const replyNow = new Date().toISOString();
          const reply: Message = {
            id: newId('msg'),
            session_id: sessionId,
            role: 'assistant',
            content: replyContent,
            created_at: replyNow,
          };
          mockState.messagesBySession[sessionId] = [
            ...(mockState.messagesBySession[sessionId] ?? []),
            reply,
          ];
          mockState.sessions = mockState.sessions.map((s) =>
            s.id === sessionId
              ? {
                  ...s,
                  last_message_preview: truncatePreview(replyContent),
                  last_message_at: replyNow,
                }
              : s
          );
          qc.setQueryData<GetSessionDetailData>(sessionKeys.detail(sessionId), (prev) =>
            prev
              ? {
                  session: {
                    ...prev.session,
                    messages: [...prev.session.messages, reply],
                  },
                }
              : prev
          );
          void qc.invalidateQueries({ queryKey: sessionKeys.lists() });

          // 打字结束
          setTyping(sessionId, false);
        }, randomDelayMs());

        return { message: userMsg };
      }
      return postMessage(sessionId, body);
    },
  });
}
