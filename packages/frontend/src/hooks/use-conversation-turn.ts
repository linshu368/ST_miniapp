'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG,
  type ChatMessage,
  type ChatMessageStatus,
  type ChatTurnFailureKind,
  type GetCharacterFreeQuotaData,
  type GetConversationData,
} from '@miniapp/shared';
import { useQueryClient } from '@tanstack/react-query';

import {
  ConversationStreamError,
  createConversationRequestId,
  streamConversationTurn,
} from '@/lib/api/conversation-stream';
import { ApiClientError } from '@/lib/api/client';
import {
  conversationKeys,
  fetchConversationDetail,
  useCancelConversationTurnMutation,
} from '@/lib/api/conversations';
import { freeQuotaKeys, useCharacterFreeQuotaQuery } from '@/lib/api/free-quota';
import { paymentKeys } from '@/lib/api/payment';
import { formatFreeQuotaExhaustedNotice } from '@/lib/free-quota-dialog';
import { createLogger } from '@/lib/logger';
import { mergeStreamingMessages, type StreamingTurn } from '@/lib/merge-streaming-messages';
import {
  isInsufficientCreditsError,
  redirectToRecharge,
  requiredCreditsFromError,
} from '@/lib/recharge-redirect';
import { getReplayLifecycle } from '@/lib/telemetry';
import { MAIN_WALLET_NOTICE } from '@/lib/vip/presentation';

const REPLY_STALLED_NOTICE_MS = 8_000;
export const CANCEL_DISCOVERY_DEADLINE_MS = 30_000;
const FREE_QUOTA_REFRESH_DELAYS_MS = [0, 300, 900] as const;
const log = createLogger('conversation-turn');

interface UseConversationTurnOptions {
  characterId: string;
  characterName?: string | null;
  sessionId: string | null;
  selectedModelId: string | null;
  selectedModelUsesFreeQuota?: boolean | null;
  persistedMessages: ChatMessage[];
  returnTo: string;
  onSessionGone: () => void;
  goBack: () => void;
  onRestoreSendContent: (content: string) => void;
}

type PendingTurn = {
  sessionId: string;
  turnIndex: number;
  revision: number;
  assistantMessageId: string | null;
  requestId: string;
  unaccepted?: boolean;
};

/** start 可能被缓冲；turn/revision 不能区分同时提交的设备，必须核对本请求 UUID。 */
export function findPendingTurnMessage(
  messages: ChatMessage[],
  pending: PendingTurn
): ChatMessage | undefined {
  return messages.find(
    (message) =>
      message.role === 'assistant' &&
      message.session_id === pending.sessionId &&
      (pending.assistantMessageId
        ? message.id === pending.assistantMessageId
        : message.request_id === pending.requestId &&
          message.turn_index === pending.turnIndex &&
          message.revision === pending.revision)
  );
}

type TurnTelemetryMeta = {
  mode: 'send' | 'regenerate';
  turnIndex: number;
  revision: number;
  selectedModelId: string | null;
  startedAt: number;
};

/**
 * 会话域 revision 从 0 起；shared 事件契约要求 revision > 0。
 * T5 不得改契约，因此把 0 投影为 1；> 0 原样上报。
 */
export function toTelemetryRevision(revision: number): number {
  return revision < 1 ? 1 : revision;
}

export function estimateChatTurnTelemetry(input: {
  mode: 'send' | 'regenerate';
  messages: ChatMessage[];
}): { turnIndex: number; revision: number } {
  const last = input.messages.at(-1);
  if (input.mode === 'regenerate') {
    return {
      turnIndex: last && last.turn_index > 0 ? last.turn_index : 1,
      revision: toTelemetryRevision((last?.revision ?? 0) + 1),
    };
  }
  return {
    turnIndex: (last?.turn_index ?? 0) + 1,
    revision: 1,
  };
}

export function classifyChatTurnFailure(error: unknown): ChatTurnFailureKind {
  if (error instanceof ConversationStreamError) {
    if (
      error.code === 'insufficient_balance' ||
      error.code === 'session_not_found' ||
      error.code === 'character_not_found' ||
      error.code === 'session_busy' ||
      error.code === 'regenerate_not_allowed' ||
      error.status === 402
    ) {
      return 'business';
    }
    if (error.status === 408 || error.status === 504) return 'timeout';
    if (error.code === 'upstream_error') return 'unknown';
    if (error.status >= 400 && error.status < 500) return 'business';
    return 'unknown';
  }
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  return 'network';
}

function safelyRunTelemetry(run: () => void): void {
  try {
    run();
  } catch {
    // 分析失败不得影响 SSE / Abort / 用户可见错误
  }
}

function turnDurationMs(startedAt: number): number {
  return Math.max(0, Math.round(Date.now() - startedAt));
}

function captureTurnLifecycleEvent(
  sessionId: string,
  characterId: string,
  meta: TurnTelemetryMeta,
  event:
    | { type: 'started' }
    | { type: 'stream_opened' }
    | { type: 'completed' }
    | { type: 'failed'; failureKind: ChatTurnFailureKind }
): void {
  safelyRunTelemetry(() => {
    const lifecycle = getReplayLifecycle();
    const base = {
      character_id: characterId,
      conversation_session_id: sessionId,
      selected_model_id: meta.selectedModelId,
      turn_index: meta.turnIndex,
      revision: meta.revision,
    };
    const isRegen = meta.mode === 'regenerate';
    switch (event.type) {
      case 'started':
        if (isRegen) {
          lifecycle.capture({ event: 'chat_regeneration_requested', ...base });
        } else {
          lifecycle.capture({ event: 'chat_turn_started', ...base });
        }
        return;
      case 'stream_opened':
        lifecycle.capture({
          event: 'chat_stream_opened',
          ...base,
        });
        return;
      case 'completed': {
        const duration_ms = turnDurationMs(meta.startedAt);
        if (isRegen) {
          lifecycle.capture({ event: 'chat_regeneration_completed', ...base, duration_ms });
        } else {
          lifecycle.capture({ event: 'chat_turn_completed', ...base, duration_ms });
        }
        return;
      }
      case 'failed': {
        const duration_ms = turnDurationMs(meta.startedAt);
        if (isRegen) {
          lifecycle.capture({
            event: 'chat_regeneration_failed',
            ...base,
            duration_ms,
            failure_kind: event.failureKind,
          });
        } else {
          lifecycle.capture({
            event: 'chat_turn_failed',
            ...base,
            duration_ms,
            failure_kind: event.failureKind,
          });
        }
      }
    }
  });
}

function failureKindFromSettledStatus(_status: ChatMessageStatus): ChatTurnFailureKind {
  return 'unknown';
}

/**
 * 一轮对话的发送 / 重生成 / 停止。流式临时态、卡顿提示、402 与流内失败都在这里。
 * 会话身份不在这里，见 use-chat-session。
 */
export function useConversationTurn({
  characterId,
  characterName,
  sessionId,
  selectedModelId,
  selectedModelUsesFreeQuota,
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
  const cancelMutation = useCancelConversationTurnMutation();
  const cancelTurn = cancelMutation.mutateAsync;

  const [streaming, setStreaming] = useState<StreamingTurn | null>(null);
  const [quotaRefreshing, setQuotaRefreshing] = useState(false);
  const [replyStalled, setReplyStalled] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [freeQuotaExhaustedMessageId, setFreeQuotaExhaustedMessageId] = useState<string | null>(
    null
  );
  const abortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<PendingTurn | null>(null);
  const requestRef = useRef<symbol | null>(null);
  const cancelRef = useRef<symbol | null>(null);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const [cancelling, setCancelling] = useState(false);

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
    requestRef.current = null;
    pendingRef.current = null;
    cancelRef.current = null;
    setCancelling(false);
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(null);
    setQuotaRefreshing(false);
    setStreamError(null);
    safelyRunTelemetry(() => getReplayLifecycle().setStreaming(false));
  }, [sessionId]);

  // 离开页面时停掉读流。后端不会因此终止，但本地不该再往一个卸载了的组件里写
  useEffect(
    () => () => {
      requestRef.current = null;
      cancelRef.current = null;
      abortRef.current?.abort();
    },
    []
  );

  const messages = useMemo(
    () => mergeStreamingMessages(persistedMessages, streaming, sessionId),
    [persistedMessages, sessionId, streaming]
  );

  const serverBusy = persistedMessages.some((message) => message.status === 'streaming');
  const generating = streaming !== null || quotaRefreshing || serverBusy || cancelling;
  const lastMessage = messages.at(-1);
  const replyProgressKey = streaming
    ? `local:${streaming.assistantMessageId ?? 'waiting'}:${streaming.text.length}`
    : serverBusy && lastMessage?.status === 'streaming'
      ? `server:${lastMessage.id}:${lastMessage.content.length}`
      : null;

  // 首字迟迟不到、或正文一段时间不再增长时，先给低干扰的等待提示。
  // 后端 110 秒内终止活跃生成，120 秒回收残留；终态回来后再明确告知不扣费。
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
      assistantMessageId: string | null,
      isCurrent: () => boolean
    ): Promise<void> => {
      void queryClient.invalidateQueries({ queryKey: paymentKeys.wallet() });
      if (selectedModelUsesFreeQuota === false) return;

      const freeQuotaKey = freeQuotaKeys.detail(characterId);

      try {
        for (const delayMs of FREE_QUOTA_REFRESH_DELAYS_MS) {
          if (delayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, delayMs));
          if (!isCurrent()) return;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const result = await Promise.race([
            refetchFreeQuota(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('Free quota refresh timeout')), 10_000);
            }),
          ]).finally(() => clearTimeout(timer));
          if (!isCurrent()) return;
          const { data } = result;
          if (!data) continue;

          freeQuotaRef.current = data;
          queryClient.setQueryData(freeQuotaKey, data);

          if (!before) return;
          if (before.used_rounds < data.quota_limit && data.used_rounds >= data.quota_limit) {
            if (assistantMessageId) setFreeQuotaExhaustedMessageId(assistantMessageId);
            return;
          }
          if (data.used_rounds > before.used_rounds || before.used_rounds >= before.quota_limit) {
            return;
          }
        }

        void queryClient.invalidateQueries({ queryKey: freeQuotaKey });
      } catch (error) {
        if (!isCurrent()) return;
        log.warn('free quota refresh failed after conversation turn', error);
        void queryClient.invalidateQueries({ queryKey: freeQuotaKey });
      }
    },
    [characterId, queryClient, refetchFreeQuota, selectedModelUsesFreeQuota]
  );

  const handleTurnFailure = useCallback(
    async (
      error: unknown,
      input: { mode: 'send' | 'regenerate'; content?: string },
      isCurrent: () => boolean
    ): Promise<void> => {
      const aborted = error instanceof Error && error.name === 'AbortError';

      // 无论怎么收场，后端都已经在写这一轮了，落库态必须重新拉一次
      setStreaming(null);
      if (sessionId) {
        void queryClient.invalidateQueries({ queryKey: conversationKeys.detail(sessionId) });
      }
      if (aborted) return;

      if (!(error instanceof ConversationStreamError)) {
        setStreamError('连接已中断，请确认本次回复状态，或取消后重新生成');
        return;
      }

      if (
        !pendingRef.current?.assistantMessageId &&
        (isInsufficientCreditsError(error) ||
          [
            'VIP_REQUIRED',
            'MAIN_CREDITS_INSUFFICIENT',
            'TOTAL_CREDITS_INSUFFICIENT',
            'session_not_found',
            'character_not_found',
            'session_busy',
            'regenerate_not_allowed',
          ].includes(error.code ?? ''))
      ) {
        if (pendingRef.current) pendingRef.current.unaccepted = true;
      }

      if (isInsufficientCreditsError(error)) {
        void redirectToRecharge(router, {
          returnTo,
          requiredCredits: requiredCreditsFromError(error),
          triggerSource: 'chat_sse',
        });
        restoreDraft(input);
        return;
      }

      switch (error.code) {
        case 'VIP_REQUIRED':
          router.push('/vip');
          restoreDraft(input);
          return;
        case 'MAIN_CREDITS_INSUFFICIENT':
          setStreamError(MAIN_WALLET_NOTICE);
          restoreDraft(input);
          return;
        case 'TOTAL_CREDITS_INSUFFICIENT':
          void redirectToRecharge(router, {
            returnTo,
            requiredCredits: requiredCreditsFromError(error),
            triggerSource: 'chat_sse',
          });
          restoreDraft(input);
          return;
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
          if (error.code === 'upstream_error' || error.status === 408 || error.status >= 500) {
            // 断流/本地超时不等于后端没接单；把已入库输入放回 composer 会诱发重复发送。
            // 只有明确的 HTTP 拒绝且有界回查未发现本轮消息时才恢复草稿。
            if (
              error.status >= 400 &&
              error.status !== 408 &&
              error.status !== 504 &&
              !pendingRef.current?.assistantMessageId &&
              sessionId
            ) {
              try {
                const pending = pendingRef.current;
                const detail = await queryClient.fetchQuery({
                  queryKey: conversationKeys.detail(sessionId),
                  queryFn: () => fetchConversationDetail(sessionId),
                  staleTime: 0,
                  retry: false,
                });
                if (!isCurrent()) return;
                if (pending && !findPendingTurnMessage(detail.messages, pending)) {
                  pending.unaccepted = true;
                  restoreDraft(input);
                }
              } catch {
                // 无法确认时保留服务端状态，不提供可能重复的发送草稿。
              }
            }
            return;
          }
          restoreDraft(input);
      }
    },
    [goBack, onSessionGone, queryClient, restoreDraft, returnTo, router, sessionId]
  );

  const runTurn = useCallback(
    async (input: { mode: 'send' | 'regenerate'; content?: string }) => {
      if (!sessionId || requestRef.current || cancelRef.current || serverBusy || quotaRefreshing)
        return;
      const requestId = createConversationRequestId();
      const request = Symbol('turn');
      requestRef.current = request;
      const isCurrent = () => requestRef.current === request && sessionRef.current === sessionId;
      const last = persistedMessages.at(-1);
      pendingRef.current = {
        sessionId,
        turnIndex: input.mode === 'send' ? (last?.turn_index ?? 0) + 1 : (last?.turn_index ?? 1),
        revision: input.mode === 'send' ? 0 : (last?.revision ?? 0) + 1,
        assistantMessageId: null,
        requestId,
      };

      // 本轮之前的额度。生成结束后要拿它跟新值比，判断额度是不是刚好在这一轮见底
      const quotaBefore = freeQuotaRef.current;
      const estimated = estimateChatTurnTelemetry({
        mode: input.mode,
        messages: persistedMessages,
      });
      const turnMeta: TurnTelemetryMeta = {
        mode: input.mode,
        turnIndex: estimated.turnIndex,
        revision: estimated.revision,
        selectedModelId,
        startedAt: Date.now(),
      };

      const controller = new AbortController();
      abortRef.current = controller;
      setStreamError(null);
      captureTurnLifecycleEvent(sessionId, characterId, turnMeta, { type: 'started' });
      safelyRunTelemetry(() => getReplayLifecycle().setStreaming(true));

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
        requestId,
        userMessage: optimisticUser,
        assistantMessageId: null,
        turnIndex: pendingRef.current.turnIndex,
        revision: pendingRef.current.revision,
        text: '',
      });

      let assistantMessageId: string | null = null;
      let settledStatus: ChatMessageStatus | null = null;

      try {
        await streamConversationTurn({
          sessionId,
          requestId,
          content: input.content,
          signal: controller.signal,
          onStart: (event) => {
            if (!isCurrent()) return;
            pendingRef.current = {
              sessionId,
              turnIndex: event.turn_index,
              revision: event.revision,
              assistantMessageId: event.assistant_message_id,
              requestId,
            };
            assistantMessageId = event.assistant_message_id;
            turnMeta.turnIndex = event.turn_index;
            turnMeta.revision = toTelemetryRevision(event.revision);
            captureTurnLifecycleEvent(sessionId, characterId, turnMeta, {
              type: 'stream_opened',
            });
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
            if (!isCurrent()) return;
            setStreaming((current) =>
              current ? { ...current, text: current.text + text } : current
            );
          },
          onDone: (event) => {
            if (!isCurrent()) return;
            assistantMessageId = event.assistant_message_id;
            settledStatus = event.status;
          },
        });

        if (!isCurrent()) return;
        // 先等落库态回来再撤临时态，顺序反过来中间会闪一帧空白
        await queryClient.invalidateQueries({ queryKey: conversationKeys.detail(sessionId) });
        if (!isCurrent()) return;
        pendingRef.current = null;
        setQuotaRefreshing(true);
        setStreaming(null);
        if (settledStatus && settledStatus !== 'complete') {
          captureTurnLifecycleEvent(sessionId, characterId, turnMeta, {
            type: 'failed',
            failureKind: failureKindFromSettledStatus(settledStatus),
          });
        } else {
          captureTurnLifecycleEvent(sessionId, characterId, turnMeta, { type: 'completed' });
        }
        await refreshQuotaAndBalance(quotaBefore, assistantMessageId, isCurrent);
      } catch (error) {
        if (!isCurrent()) return;
        const aborted = error instanceof Error && error.name === 'AbortError';
        if (!aborted) {
          captureTurnLifecycleEvent(sessionId, characterId, turnMeta, {
            type: 'failed',
            failureKind: classifyChatTurnFailure(error),
          });
        }
        await handleTurnFailure(error, input, isCurrent);
      } finally {
        if (!isCurrent()) return;
        requestRef.current = null;
        setQuotaRefreshing(false);
        safelyRunTelemetry(() => getReplayLifecycle().setStreaming(false));
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [
      characterId,
      handleTurnFailure,
      persistedMessages,
      queryClient,
      refreshQuotaAndBalance,
      selectedModelId,
      serverBusy,
      quotaRefreshing,
      sessionId,
    ]
  );

  const abort = useCallback(async () => {
    if (!sessionId || cancelRef.current || quotaRefreshing) return;
    const cancellation = Symbol('cancel');
    cancelRef.current = cancellation;
    setCancelling(true);
    setStreamError(null);
    const isCurrent = () => cancelRef.current === cancellation && sessionRef.current === sessionId;
    try {
      const pending = pendingRef.current?.sessionId === sessionId ? pendingRef.current : null;
      let message = pending
        ? findPendingTurnMessage(persistedMessages, pending)
        : persistedMessages.find(
            (item) => item.role === 'assistant' && item.status === 'streaming'
          );
      let assistantMessageId = pending?.assistantMessageId ?? message?.id;
      // 保留一次点击的取消意图，覆盖后端 20 秒准备 + 开轮 RPC；总发现等待最多 30 秒。
      const discoveryDeadline = Date.now() + CANCEL_DISCOVERY_DEADLINE_MS;
      while (!assistantMessageId && pending && Date.now() < discoveryDeadline) {
        if (!isCurrent()) return;
        if (pending.unaccepted) {
          // 明确拒绝且未开轮时无可取消的服务端消息，恢复原输入并结束等待。
          if (streaming?.mode === 'send' && streaming.userMessage)
            onRestoreSendContent(streaming.userMessage.content);
          setStreaming(null);
          setStreamError('本次回复未开始，原消息已保留');
          return;
        }
        assistantMessageId = pendingRef.current?.assistantMessageId ?? undefined;
        if (assistantMessageId) break;
        const remaining = discoveryDeadline - Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let detail: GetConversationData;
        try {
          detail = await Promise.race([
            queryClient.fetchQuery({
              queryKey: conversationKeys.detail(sessionId),
              queryFn: () => fetchConversationDetail(sessionId, Math.min(10_000, remaining)),
              staleTime: 0,
              retry: false,
            }),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error('本次回复尚未确认，请稍后重试取消')),
                remaining
              );
            }),
          ]).finally(() => clearTimeout(timer));
        } catch (error) {
          if (!isCurrent()) return;
          if (
            error instanceof ApiClientError &&
            error.status >= 400 &&
            error.status < 500 &&
            error.status !== 408 &&
            error.status !== 429
          )
            throw error;
          assistantMessageId = pendingRef.current?.assistantMessageId ?? undefined;
          if (assistantMessageId) break;
          if (Date.now() >= discoveryDeadline) break;
          await new Promise((resolve) =>
            window.setTimeout(resolve, Math.min(1_000, discoveryDeadline - Date.now()))
          );
          continue;
        }
        if (!isCurrent()) return;
        message = findPendingTurnMessage(detail.messages, pending);
        assistantMessageId = pendingRef.current?.assistantMessageId ?? message?.id;
        if (message && !pending.unaccepted) {
          const discovered = message;
          pending.assistantMessageId = discovered.id;
          setStreaming((current) =>
            current
              ? {
                  ...current,
                  assistantMessageId: discovered.id,
                  turnIndex: discovered.turn_index,
                  revision: discovered.revision,
                  userMessage: current.userMessage
                    ? (detail.messages.find(
                        (item) => item.role === 'user' && item.turn_index === discovered.turn_index
                      ) ?? current.userMessage)
                    : null,
                }
              : current
          );
        }
        if (!assistantMessageId && Date.now() < discoveryDeadline)
          await new Promise((resolve) =>
            window.setTimeout(resolve, Math.min(500, discoveryDeadline - Date.now()))
          );
      }
      if (!isCurrent()) return;
      if (pending?.unaccepted) {
        if (streaming?.mode === 'send' && streaming.userMessage)
          onRestoreSendContent(streaming.userMessage.content);
        setStreaming(null);
        setStreamError('本次回复未开始，原消息已保留');
        return;
      }
      if (!assistantMessageId) throw new Error('本次回复尚未确认，请稍后重试取消');
      const result = await cancelTurn({ sessionId, assistantMessageId });
      if (!isCurrent()) return;
      if (result.message.status === 'streaming') throw new Error('本次回复仍在生成，请重试取消');
      const optimisticUser = streaming?.userMessage;
      queryClient.setQueryData<GetConversationData>(
        conversationKeys.detail(sessionId),
        (detail) => {
          if (!detail) return detail;
          if (
            detail.messages.some(
              (item) =>
                item.role === 'assistant' &&
                item.turn_index === result.message.turn_index &&
                item.revision > result.message.revision
            )
          )
            return detail;
          const rows = detail.messages.filter((item) => item.id !== result.message.id);
          if (
            optimisticUser &&
            !rows.some(
              (item) => item.role === 'user' && item.turn_index === result.message.turn_index
            )
          ) {
            rows.push({
              ...optimisticUser,
              id: `${result.message.id}:user`,
              turn_index: result.message.turn_index,
              revision: result.message.revision,
            });
          }
          rows.push(result.message);
          rows.sort(
            (left, right) =>
              left.turn_index - right.turn_index ||
              (left.role === right.role ? 0 : left.role === 'user' ? -1 : 1)
          );
          return { ...detail, messages: rows };
        }
      );
      // 只有服务端确认终态才撤本地占位；隔离旧 stream 的 finally 和 delta。
      requestRef.current = null;
      pendingRef.current = null;
      abortRef.current?.abort();
      abortRef.current = null;
      setStreaming(null);
      setQuotaRefreshing(false);
      safelyRunTelemetry(() => getReplayLifecycle().setStreaming(false));
      void queryClient.invalidateQueries({ queryKey: paymentKeys.wallet() });
      void queryClient.invalidateQueries({ queryKey: freeQuotaKeys.detail(characterId) });
    } catch (error) {
      if (isCurrent()) setStreamError(error instanceof Error ? error.message : '取消失败，请重试');
    } finally {
      if (isCurrent()) {
        cancelRef.current = null;
        setCancelling(false);
      }
    }
  }, [
    cancelTurn,
    characterId,
    persistedMessages,
    onRestoreSendContent,
    queryClient,
    quotaRefreshing,
    sessionId,
    streaming,
  ]);

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
    cancelling,
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
