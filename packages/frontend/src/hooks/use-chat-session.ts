'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useConversationQuery, useCreateConversationMutation } from '@/lib/api/conversations';
import { chatEntryPath } from '@/lib/chat-entry';
import {
  resolveRoleplaySource,
  roleplayReturnPath,
  type RoleplaySource,
} from '@/lib/roleplay-navigation';

function replaceChatUrl(
  characterId: string,
  sessionId: string | null,
  source: RoleplaySource
): void {
  window.history.replaceState(
    null,
    '',
    chatEntryPath(characterId, { sessionId: sessionId ?? undefined, source })
  );
}

function entryErrorMessage(
  createError: unknown,
  detailCode: string | undefined,
  createFailed: boolean,
  detailFailed: boolean
): string | null {
  const createCode =
    createError instanceof Error ? (createError as { code?: string }).code : undefined;
  if (
    [createCode, detailCode].some((code) => code === 'UNAUTHORIZED' || code === 'AUTH_REQUIRED')
  ) {
    return '登录信息已失效，请从 Telegram 重新打开小程序';
  }
  if (createFailed) return '对话创建失败，请重试';
  return detailFailed && detailCode !== 'session_not_found' && detailCode !== 'NOT_FOUND'
    ? '对话加载失败，请重试'
    : null;
}

/**
 * 聊天页的会话身份：创建、URL `?session=` 同步、失效后重建。
 * 生成行为不在这里，见 use-conversation-turn。
 */
export function useChatSession(characterId: string) {
  const searchParams = useSearchParams();
  const source = resolveRoleplaySource(searchParams.get('from'));
  const backHref = roleplayReturnPath(source);
  const [sessionId, setSessionId] = useState<string | null>(() => searchParams.get('session'));
  const [entryAttempt, setEntryAttempt] = useState(0);

  const createConversation = useCreateConversationMutation();
  const resetCreatedConversation = createConversation.reset;
  const createdSessionId = createConversation.data?.session.id ?? null;
  const activeSessionId = sessionId ?? createdSessionId;
  const conversationQuery = useConversationQuery(activeSessionId ?? undefined, createdSessionId);

  const returnTo = useMemo(
    () =>
      activeSessionId
        ? chatEntryPath(characterId, { sessionId: activeSessionId, source })
        : chatEntryPath(characterId, { source }),
    [characterId, activeSessionId, source]
  );

  /**
   * 无 ?session= 就建一个新的；建完把 id 补进 URL，刷新页面不会又建一个空会话。
   * mutate 的 onSuccess 在 React Strict Mode 重挂时可能被丢掉，所以 session 以
   * mutation.data 为准；effect cleanup 必须放开 in-flight 锁，否则重挂后不会再发。
   */
  const creatingRef = useRef(false);
  useEffect(() => {
    if (activeSessionId || !characterId || creatingRef.current) return;
    creatingRef.current = true;

    createConversation.mutate(characterId, {
      onSuccess: (data) => {
        setSessionId(data.session.id);
        replaceChatUrl(characterId, data.session.id, source);
      },
      onSettled: () => {
        creatingRef.current = false;
      },
    });

    return () => {
      creatingRef.current = false;
    };
    // createConversation 每次渲染都是新引用，只在这几项变化时重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId, activeSessionId, entryAttempt, source]);

  useEffect(() => {
    if (sessionId || !createdSessionId) return;
    setSessionId(createdSessionId);
    replaceChatUrl(characterId, createdSessionId, source);
  }, [characterId, createdSessionId, sessionId, source]);

  // 会话被删或不属于当前用户：URL 里的 id 已经没用了，清掉让上面的分支重建一个
  const detailErrorCode =
    conversationQuery.error instanceof Error
      ? (conversationQuery.error as { code?: string }).code
      : undefined;
  const abandonSession = useCallback(() => {
    resetCreatedConversation();
    setSessionId(null);
    replaceChatUrl(characterId, null, source);
  }, [characterId, source, resetCreatedConversation]);

  useEffect(() => {
    if (detailErrorCode !== 'session_not_found' && detailErrorCode !== 'NOT_FOUND') return;
    abandonSession();
  }, [abandonSession, detailErrorCode]);

  const openNewConversation = useCallback(() => {
    createConversation.mutate(characterId, {
      onSuccess: (data) => {
        setSessionId(data.session.id);
        replaceChatUrl(characterId, data.session.id, source);
      },
    });
  }, [characterId, source, createConversation]);

  const selectSession = useCallback(
    (nextSessionId: string) => {
      setSessionId(nextSessionId);
      replaceChatUrl(characterId, nextSessionId, source);
    },
    [characterId, source]
  );

  const retryEntry = useCallback(() => {
    createConversation.reset();
    setEntryAttempt((attempt) => attempt + 1);
    if (activeSessionId) void conversationQuery.refetch();
  }, [activeSessionId, conversationQuery, createConversation]);

  const entryError = entryErrorMessage(
    createConversation.error,
    detailErrorCode,
    createConversation.isError,
    conversationQuery.isError
  );

  const ready = Boolean(activeSessionId) && conversationQuery.isSuccess;

  return {
    backHref,
    activeSessionId,
    abandonSession,
    conversationQuery,
    createConversation,
    entryError,
    openNewConversation,
    ready,
    retryEntry,
    returnTo,
    selectSession,
    detailErrorCode,
  };
}
