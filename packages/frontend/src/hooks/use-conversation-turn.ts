'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG,
  type ChatMessage,
  type GetCharacterFreeQuotaData,
} from '@miniapp/shared';
import { useQueryClient } from '@tanstack/react-query';

import { ConversationStreamError, streamConversationTurn } from '@/lib/api/conversation-stream';
import { conversationKeys } from '@/lib/api/conversations';
import { useCharacterFreeQuotaQuery } from '@/lib/api/free-quota';
import { paymentKeys } from '@/lib/api/payment';
import { formatFreeQuotaExhaustedNotice } from '@/lib/free-quota-dialog';
import { mergeStreamingMessages, type StreamingTurn } from '@/lib/merge-streaming-messages';
import {
  isInsufficientCreditsError,
  redirectToRecharge,
  requiredCreditsFromError,
} from '@/lib/recharge-redirect';

const REPLY_STALLED_NOTICE_MS = 15_000;

interface UseConversationTurnOptions {
  characterId: string;
  characterName?: string | null;
  sessionId: string | null;
  persistedMessages: ChatMessage[];
  returnTo: string;
  onSessionGone: () => void;
  goBack: () => void;
  onRestoreSendContent: (content: string) => void;
}

/**
 * 一轮对话的发送 / 重生成 / 停止。流式临时态、卡顿提示、402 与流内失败都在这里。
 * 会话身份不在这里，见 use-chat-session。
 */
export function useConversationTurn({
  characterId,
  characterName,
  sessionId,
  persistedMessages,
  returnTo,
  onSessionGone,
  goBack,
  onRestoreSendContent,
}: UseConversationTurnOptions) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const freeQuotaQuery = useCharacterFreeQuotaQuery(characterId);
  const refetchFreeQuota = freeQuotaQuery.refetch;

  const [streaming, setStreaming] = useState<StreamingTurn | null>(null);
  const [replyStalled, setReplyStalled] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [freeQuotaExhaustedMessageId, setFreeQuotaExhaustedMessageId] = useState<string | null>(
    null
  );
  const abortRef = useRef<AbortController | null>(null);

  /**
   * 额度快照要在 runTurn 里按调用时刻取，而 runTurn 是 useCallback——直接读
   * freeQuotaQuery.data 拿到的是创建那一帧的值（首帧通常还是 undefined）。
   * 用 ref 兜住最新值，判定「刚好在这一轮用完」才有本轮之前的基准可比。
   */
  const freeQuotaRef = useRef<GetCharacterFreeQuotaData | undefined>(undefined);
  useEffect(() => {
    freeQuotaRef.current = freeQuotaQuery.data;
  }, [freeQuotaQuery.data]);

  // 切会话时把上一段的临时态全部丢掉，包括在途的流
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(null);
    setStreamError(null);
  }, [sessionId]);

  // 离开页面时停掉读流。后端不会因此终止，但本地不该再往一个卸载了的组件里写
  useEffect(() => () => abortRef.current?.abort(), []);

  const messages = useMemo(
    () => mergeStreamingMessages(persistedMessages, streaming, sessionId),
    [persistedMessages, sessionId, streaming]
  );

  const serverBusy = persistedMessages.some((message) => message.status === 'streaming');
  const generating = streaming !== null;
  const lastMessage = messages.at(-1);
  const replyProgressKey = streaming
    ? `local:${streaming.assistantMessageId ?? 'waiting'}:${streaming.text.length}`
    : serverBusy && lastMessage?.status === 'streaming'
      ? `server:${lastMessage.id}:${lastMessage.content.length}`
      : null;

  // 首字迟迟不到、或正文一段时间不再增长时，先给低干扰的等待提示。
  // 真正的 120 秒终止由后端负责，终态回来后再明确告知不扣费。
  useEffect(() => {
    setReplyStalled(false);
    if (!replyProgressKey) return;

    const timer = window.setTimeout(() => setReplyStalled(true), REPLY_STALLED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [replyProgressKey]);

  const canRegenerate =
    !generating && !serverBusy && lastMessage?.role === 'assistant' && lastMessage.turn_index > 0;

  const restoreDraft = useCallback(
    (input: { mode: 'send' | 'regenerate'; content?: string }) => {
      if (input.mode !== 'send' || !input.content) return;
      onRestoreSendContent(input.content);
    },
    [onRestoreSendContent]
  );

  /**
   * 免费额度是否刚好在这一轮用完。后端的 done 事件不带额度信息，
   * 只能生成结束后回查一次；扣费与消息落库不在同一个事务里，所以要留一点重试余地。
   *
   * before 由调用方在发起本轮之前抓好传进来。读闭包里的 freeQuotaQuery.data 不行——
   * 那个值会被 runTurn 的 useCallback 冻住，判定条件永远不成立。
   */
  const refreshQuotaAndBalance = useCallback(
    async (
      before: GetCharacterFreeQuotaData | undefined,
      assistantMessageId: string | null
    ): Promise<void> => {
      void queryClient.invalidateQueries({ queryKey: paymentKeys.wallet() });

      for (const delayMs of [0, 300, 900]) {
        if (delayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, delayMs));
        const { data } = await refetchFreeQuota();
        if (!data || !before) return;
        if (before.used_rounds < data.quota_limit && data.used_rounds >= data.quota_limit) {
          if (assistantMessageId) setFreeQuotaExhaustedMessageId(assistantMessageId);
          return;
        }
        if (data.used_rounds > before.used_rounds) return;
      }
    },
    [queryClient, refetchFreeQuota]
  );

  const handleTurnFailure = useCallback(
    async (
      error: unknown,
      input: { mode: 'send' | 'regenerate'; content?: string }
    ): Promise<void> => {
      const aborted = error instanceof Error && error.name === 'AbortError';

      // 无论怎么收场，后端都已经在写这一轮了，落库态必须重新拉一次
      setStreaming(null);
      if (sessionId) {
        void queryClient.invalidateQueries({ queryKey: conversationKeys.detail(sessionId) });
      }
      if (aborted) return;

      if (!(error instanceof ConversationStreamError)) {
        setStreamError('网络异常，请重试');
        restoreDraft(input);
        return;
      }

      if (isInsufficientCreditsError(error)) {
        redirectToRecharge(router, {
          returnTo,
          requiredCredits: requiredCreditsFromError(error),
        });
        restoreDraft(input);
        return;
      }

      switch (error.code) {
        case 'session_not_found':
          onSessionGone();
          setStreamError('这段对话已不存在，已为你开启新的对话');
          restoreDraft(input);
          return;
        case 'character_not_found':
          setStreamError('这个角色已下架');
          window.setTimeout(goBack, 1_200);
          return;
        case 'session_busy':
          setStreamError('上一条还在生成，请稍候');
          restoreDraft(input);
          return;
        case 'regenerate_not_allowed':
          setStreamError('这条回复不能重新生成了');
          return;
        default:
          setStreamError(error.message || '生成失败，请重试');
          restoreDraft(input);
      }
    },
    [goBack, onSessionGone, queryClient, restoreDraft, returnTo, router, sessionId]
  );

  const runTurn = useCallback(
    async (input: { mode: 'send' | 'regenerate'; content?: string }) => {
      if (!sessionId) return;

      // 本轮之前的额度。生成结束后要拿它跟新值比，判断额度是不是刚好在这一轮见底
      const quotaBefore = freeQuotaRef.current;

      const controller = new AbortController();
      abortRef.current = controller;
      setStreamError(null);

      const optimisticUser: ChatMessage | null =
        input.mode === 'send' && input.content !== undefined
          ? {
              id: `local:${Date.now()}`,
              session_id: sessionId,
              turn_index: Number.MAX_SAFE_INTEGER,
              role: 'user',
              revision: 0,
              content: input.content,
              status: 'complete',
              error_code: null,
              finish_reason: null,
              model_id: null,
              created_at: new Date().toISOString(),
            }
          : null;

      setStreaming({
        mode: input.mode,
        userMessage: optimisticUser,
        assistantMessageId: null,
        turnIndex: 0,
        revision: 0,
        text: '',
      });

      let assistantMessageId: string | null = null;

      try {
        await streamConversationTurn({
          sessionId,
          content: input.content,
          signal: controller.signal,
          onStart: (event) => {
            assistantMessageId = event.assistant_message_id;
            setStreaming((current) =>
              current
                ? {
                    ...current,
                    assistantMessageId: event.assistant_message_id,
                    turnIndex: event.turn_index,
                    revision: event.revision,
                    userMessage: current.userMessage
                      ? {
                          ...current.userMessage,
                          id: event.user_message_id ?? current.userMessage.id,
                          turn_index: event.turn_index,
                          revision: event.revision,
                        }
                      : null,
                  }
                : current
            );
          },
          onDelta: (text) => {
            setStreaming((current) =>
              current ? { ...current, text: current.text + text } : current
            );
          },
          onDone: (event) => {
            assistantMessageId = event.assistant_message_id;
          },
        });

        // 先等落库态回来再撤临时态，顺序反过来中间会闪一帧空白
        await queryClient.invalidateQueries({ queryKey: conversationKeys.detail(sessionId) });
        setStreaming(null);
        void refreshQuotaAndBalance(quotaBefore, assistantMessageId);
      } catch (error) {
        await handleTurnFailure(error, input);
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [handleTurnFailure, queryClient, refreshQuotaAndBalance, sessionId]
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const quotaExhaustedNotice = freeQuotaExhaustedMessageId
    ? {
        messageId: freeQuotaExhaustedMessageId,
        text: formatFreeQuotaExhaustedNotice(
          freeQuotaQuery.data?.exhausted_dialog ?? DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG,
          characterName
        ),
      }
    : undefined;

  return {
    abort,
    canRegenerate,
    generating,
    lastMessage,
    messages,
    quotaExhaustedNotice,
    replyStalled,
    runTurn,
    serverBusy,
    setStreamError,
    streamError,
    streaming,
  };
}
