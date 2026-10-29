'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import {
  DEFAULT_FIRST_TOKEN_DEADLINE_MS,
  FIRST_TOKEN_RETRY_MESSAGE,
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
  CONVERSATION_RECOVERING_MESSAGE,
  createConversationRequestId,
  streamConversationTurn,
} from '@/lib/api/conversation-stream';
import { ApiClientError } from '@/lib/api/client';
import {
  reportConversationFirstToken,
  conversationKeys,
  fetchConversationDetail,
  useCancelConversationTurnMutation,
} from '@/lib/api/conversations';
import { freeQuotaKeys, useCharacterFreeQuotaQuery } from '@/lib/api/free-quota';
import { paymentKeys } from '@/lib/api/payment';
import { formatFreeQuotaExhaustedNotice } from '@/lib/free-quota-dialog';
import { createLogger } from '@/lib/logger';
import {
  appendStreamText,
  applyStreamStart,
  dropCurrentStreamingTurn,
  prunePersistedStreamingTurns,
  mergeStreamingMessages,
  type StreamingTurn,
} from '@/lib/merge-streaming-messages';
import {
  isInsufficientCreditsError,
  redirectToRecharge,
  requiredCreditsFromError,
} from '@/lib/recharge-redirect';
import { feedbackAfterPaint, startAction } from '@/lib/perf/action-tracker';
import { getMetricDimensions } from '@/lib/perf/env-tags';
import { getReplayLifecycle } from '@/lib/telemetry';
import { MAIN_WALLET_NOTICE } from '@/lib/vip/presentation';
import {
  appendMessageThinking,
  messageThinkingKey,
  type MessageThinkingMap,
} from '@/lib/chat-thinking';

import { FirstTokenObservation } from '@/lib/perf/first-token-observation';
import { RoleplayReplyTiming } from '@/lib/perf/roleplay-timing';

const REPLY_STALLED_NOTICE_MS = 8_000;
export const CANCEL_DISCOVERY_DEADLINE_MS = 30_000;
const FREE_QUOTA_REFRESH_DELAYS_MS = [0, 300, 900] as const;
const log = createLogger('conversation-turn');

/**
 * 端到端体验耗时：点击发送 → 首字 / 完整回复出现在聊天区域。
 * 和 action_stall 的区别——那个只测「UI 有没有反馈」，这个测真实等待时长，
 * 用来回答「聊天到底快不快」而不是「按钮卡没卡」。
 */
function reportChatLatency(
  metric: 'chat.first_token.duration' | 'chat.full_reply.duration',
  durationMs: number,
  attributes: { character_id: string; outcome?: 'ok' | 'failed' | 'error' }
): void {
  try {
    Sentry.metrics.distribution(metric, durationMs, {
      unit: 'millisecond',
      attributes: { ...attributes, ...getMetricDimensions() },
    });
  } catch (error) {
    log.warn(`${metric} report failed`, error);
  }
}

interface UseConversationTurnOptions {
  characterId: string;
  firstTokenDeadlineMs?: number;
  characterName?: string | null;
  sessionId: string | null;
  selectedModelId: string | null;
  selectedModelUsesFreeQuota?: boolean | null;
  thinkingEnabled?: boolean;
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
  firstTokenDeadlineMs = DEFAULT_FIRST_TOKEN_DEADLINE_MS,
  characterName,
  sessionId,
  selectedModelId,
  selectedModelUsesFreeQuota,
  thinkingEnabled = true,
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
  const [thinkingState, setThinkingState] = useState<{
    sessionId: string | null;
    messages: MessageThinkingMap;
  }>({ sessionId, messages: {} });
  const thinkingByMessage = useMemo(() => {
    const recovered: Record<string, string> = {};
    for (const message of persistedMessages) {
      if (message.reasoning) recovered[messageThinkingKey(message)] = message.reasoning;
    }
    if (thinkingState.sessionId === sessionId) {
      for (const [key, text] of Object.entries(thinkingState.messages)) {
        if (text.length > (recovered[key]?.length ?? 0)) recovered[key] = text;
      }
    }
    return recovered;
  }, [persistedMessages, thinkingState, sessionId]);
  const [quotaRefreshing, setQuotaRefreshing] = useState(false);
  const [replyStalled, setReplyStalled] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [freeQuotaExhaustedMessageId, setFreeQuotaExhaustedMessageId] = useState<string | null>(
    null
  );
  const observationRef = useRef<FirstTokenObservation | null>(null);
  const replyTimingRef = useRef<RoleplayReplyTiming | null>(null);
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

  // 切会话时先清理旧请求，必须早于下方首字 commit 裁决与浏览器绘制。
  useLayoutEffect(() => {
    replyTimingRef.current?.finish('page_left');
    replyTimingRef.current = null;
    observationRef.current?.unavailable('page_left');
    observationRef.current = null;
    requestRef.current = null;
    pendingRef.current = null;
    cancelRef.current = null;
    setCancelling(false);
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(null);
    setThinkingState({ sessionId, messages: {} });
    setQuotaRefreshing(false);
    setStreamError(null);
    safelyRunTelemetry(() => getReplayLifecycle().setStreaming(false));
  }, [sessionId]);

  // 离开页面时停掉读流。后端不会因此终止，但本地不该再往一个卸载了的组件里写
  useEffect(
    () => () => {
      replyTimingRef.current?.finish('page_left');
      observationRef.current?.unavailable('page_left');
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

  useEffect(() => {
    setStreaming((current) => prunePersistedStreamingTurns(current, persistedMessages, sessionId));
  }, [persistedMessages, sessionId, streaming]);

  // React has committed this exact message to the chat UI. Scroll position, viewport
  // geometry and disclosure state are intentionally unrelated to the delivery contract.
  useLayoutEffect(() => {
    const observation = observationRef.current;
    if (!observation) return;
    const committed = messages.find(
      (message) =>
        message.role === 'assistant' &&
        message.session_id === sessionId &&
        message.request_id === observation.identity.requestId &&
        (observation.identity.assistantMessageId === null ||
          (message.id === observation.identity.assistantMessageId &&
            message.revision === observation.identity.revision))
    );
    if (!committed) return;
    observation.identify(committed.id, committed.revision);
    const hasToken = Boolean(
      committed.content.trim() ||
      (observation.thinkingEnabled && thinkingByMessage[messageThinkingKey(committed)]?.trim())
    );
    if (hasToken) {
      observation.received('commit');
      const at = performance.now();
      if (observation.committed(observation.identity, at)) {
        reportChatLatency('chat.first_token.duration', at - observation.startedAt, {
          character_id: characterId,
        });
      }
      // A recovered late reply can replace the retry hint, but cannot rewrite its timeout.
      setStreamError(null);
    } else if (committed.status !== 'streaming') {
      if (committed.finish_reason === 'timeout') observation.deadlineFailed('server_timeout');
      else observation.unavailable('upstream_error');
    }
    // Success means the complete matching revision has actually committed to
    // React, not merely SSE done or a query invalidation resolving. Failed and
    // interrupted durable messages remain separate terminal samples.
    const replyTiming = replyTimingRef.current;
    if (
      committed.status !== 'streaming' &&
      replyTiming &&
      replyTiming.requestId === committed.request_id
    ) {
      replyTiming.finish(
        committed.finish_reason === 'timeout'
          ? 'timed_out'
          : committed.status === 'complete' && !hasToken
            ? 'failed'
            : committed.status
      );
    }
  }, [messages, sessionId, thinkingByMessage, characterId]);

  const serverBusy = persistedMessages.some((message) => message.status === 'streaming');
  const activeStreaming = streaming?.status ? null : streaming;
  const generating = activeStreaming !== null || quotaRefreshing || serverBusy || cancelling;
  const lastMessage = messages.at(-1);
  const lastThinking = lastMessage ? thinkingByMessage[messageThinkingKey(lastMessage)] : undefined;
  const replyProgressKey = activeStreaming
    ? `local:${activeStreaming.assistantMessageId ?? 'waiting'}:${activeStreaming.text.length}:${lastThinking?.length ?? 0}`
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
      isCurrent: () => boolean,
      preservePartial = false
    ): Promise<void> => {
      const aborted = error instanceof Error && error.name === 'AbortError';

      // 无论怎么收场，后端都已经在写这一轮了，落库态必须重新拉一次
      // The final SSE batch can contain text and an error together. Keep that
      // text in the message state; a later matching server snapshot takes over.
      setStreaming((current) =>
        preservePartial && current
          ? { ...current, status: 'interrupted' }
          : dropCurrentStreamingTurn(current)
      );
      if (sessionId) {
        void queryClient.invalidateQueries({ queryKey: conversationKeys.detail(sessionId) });
      }
      if (aborted) return;

      if (!(error instanceof ConversationStreamError) || error.recoverable) {
        setStreamError(CONVERSATION_RECOVERING_MESSAGE);
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
                const found = pending && findPendingTurnMessage(detail.messages, pending);
                if (found) observationRef.current?.identify(found.id, found.revision);
                if (pending && !found) {
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
      replyTimingRef.current?.finish('superseded');
      const replyTiming = new RoleplayReplyTiming(requestId, input.mode);
      replyTimingRef.current = replyTiming;
      observationRef.current?.unavailable('superseded');
      const observation = new FirstTokenObservation(
        { requestId, assistantMessageId: null, revision: 0 },
        firstTokenDeadlineMs,
        (body) => {
          void reportConversationFirstToken(sessionId, body);
        },
        () => {
          if (observationRef.current !== observation) return;
          // Client delivery telemetry never cancels a server-owned turn.
          setStreamError(FIRST_TOKEN_RETRY_MESSAGE);
        },
        thinkingEnabled,
        input.mode
      );
      observationRef.current = observation;
      const request = Symbol('turn');
      requestRef.current = request;
      const isCurrent = () => requestRef.current === request && sessionRef.current === sessionId;
      const last = messages.at(-1);
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
        messages,
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

      // 发送动作的反馈是「用户消息出现在列表」；这里测的是界面是否被卡住，网络耗时另有请求指标。
      const sendAction = input.mode === 'send' ? startAction('send_message') : null;
      const pendingTurn = pendingRef.current;
      setStreaming((current) => ({
        retained: [
          ...(current?.retained ?? []),
          ...(current?.status ? [{ ...current, retained: undefined }] : []),
        ],
        mode: input.mode,
        requestId,
        userMessage: optimisticUser,
        assistantMessageId: null,
        turnIndex: pendingTurn.turnIndex,
        revision: pendingTurn.revision,
        text: '',
        postprocessVersion: null,
      }));
      if (sendAction) feedbackAfterPaint(sendAction);

      let assistantMessageId: string | null = null;
      let assistantRevision = pendingRef.current.revision;
      let settledStatus: ChatMessageStatus | null = null;

      try {
        await streamConversationTurn({
          sessionId,
          requestId,
          thinkingEnabled,
          content: input.content,
          signal: controller.signal,
          onDispatched: () => observation.dispatched(),
          onFirstDeltaReceived: () => {
            if (isCurrent()) observation.received();
          },
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
            observation.identify(event.assistant_message_id, event.revision);
            assistantRevision = event.revision;
            turnMeta.turnIndex = event.turn_index;
            turnMeta.revision = toTelemetryRevision(event.revision);
            captureTurnLifecycleEvent(sessionId, characterId, turnMeta, {
              type: 'stream_opened',
            });
            setStreaming((current) => (current ? applyStreamStart(current, event) : current));
          },
          onDelta: (text) => {
            if (!isCurrent()) return;
            setStreaming((current) => (current ? appendStreamText(current, text) : current));
          },
          onReasoning: (text) => {
            if (!isCurrent() || !thinkingEnabled || !assistantMessageId || !text) return;
            const key = messageThinkingKey({
              session_id: sessionId,
              id: assistantMessageId,
              revision: assistantRevision,
            });
            setThinkingState((current) => ({
              sessionId,
              messages: appendMessageThinking(
                current.sessionId === sessionId ? current.messages : {},
                key,
                text
              ),
            }));
          },
          onDone: (event) => {
            if (!isCurrent()) return;
            assistantMessageId = event.assistant_message_id;
            settledStatus = event.status;
            setStreaming((current) =>
              current
                ? { ...current, status: event.status === 'streaming' ? undefined : event.status }
                : current
            );
            if (event.status !== 'complete' && !observation.hasReceivedToken) {
              observation.unavailable('upstream_error');
            }
          },
        });

        if (!isCurrent()) return;
        // 先等落库态回来再撤临时态，顺序反过来中间会闪一帧空白
        await queryClient.invalidateQueries({ queryKey: conversationKeys.detail(sessionId) });
        if (!isCurrent()) return;
        pendingRef.current = null;
        setQuotaRefreshing(true);
        // A fast invalidation can resolve against a stale snapshot. The final
        // batch stays until the matching durable response actually takes over.
        if (!settledStatus) setStreaming(dropCurrentStreamingTurn);
        if (settledStatus && settledStatus !== 'complete') {
          captureTurnLifecycleEvent(sessionId, characterId, turnMeta, {
            type: 'failed',
            failureKind: failureKindFromSettledStatus(settledStatus),
          });
        } else {
          captureTurnLifecycleEvent(sessionId, characterId, turnMeta, { type: 'completed' });
        }
        if (input.mode === 'send') {
          reportChatLatency('chat.full_reply.duration', Date.now() - turnMeta.startedAt, {
            character_id: characterId,
            outcome: settledStatus && settledStatus !== 'complete' ? 'failed' : 'ok',
          });
        }
        await refreshQuotaAndBalance(quotaBefore, assistantMessageId, isCurrent);
      } catch (error) {
        if (!isCurrent()) return;
        const aborted = error instanceof Error && error.name === 'AbortError';
        if (!aborted) {
          if (
            error instanceof ConversationStreamError &&
            !error.recoverable &&
            !observation.hasReceivedToken
          ) {
            const timedOut = [
              'first_token_timeout',
              'fallback_first_token_timeout',
              'primary_first_token_timeout',
            ].includes(error.code ?? '');
            replyTiming.finish(
              timedOut
                ? 'timed_out'
                : error.status >= 400 && error.status < 500 && !assistantMessageId
                  ? 'rejected'
                  : 'failed'
            );
          } else {
            replyTiming.recovering();
          }
        }
        if (!aborted) {
          captureTurnLifecycleEvent(sessionId, characterId, turnMeta, {
            type: 'failed',
            failureKind: classifyChatTurnFailure(error),
          });
          if (input.mode === 'send') {
            reportChatLatency('chat.full_reply.duration', Date.now() - turnMeta.startedAt, {
              character_id: characterId,
              outcome: 'error',
            });
          }
        }
        // Reception is not success: let the retained batch's React commit decide
        // delivery, with the original absolute deadline still running.
        if (error instanceof ConversationStreamError && !observation.hasReceivedToken) {
          if (error.code === 'first_token_timeout') observation.deadlineFailed('server_timeout');
          if (error.code === 'fallback_first_token_timeout')
            observation.deadlineFailed('fallback_timeout');
          if (error.code === 'primary_first_token_timeout')
            observation.deadlineFailed('primary_timeout');
        }
        if (
          error instanceof ConversationStreamError &&
          !error.recoverable &&
          !observation.hasReceivedToken
        ) {
          observation.unavailable('upstream_error');
        }
        await handleTurnFailure(error, input, isCurrent, !aborted && observation.hasReceivedToken);
        // Keep rolling-deploy compatibility with an old backend that may still hard-timeout.
        if (
          error instanceof ConversationStreamError &&
          [
            'first_token_timeout',
            'fallback_first_token_timeout',
            'primary_first_token_timeout',
          ].includes(error.code ?? '') &&
          isCurrent()
        )
          setStreamError(FIRST_TOKEN_RETRY_MESSAGE);
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
      firstTokenDeadlineMs,
      handleTurnFailure,
      messages,
      queryClient,
      refreshQuotaAndBalance,
      selectedModelId,
      thinkingEnabled,
      serverBusy,
      quotaRefreshing,
      sessionId,
    ]
  );

  const abort = useCallback(
    async (reason?: 'first_token_timeout') => {
      if (!sessionId || cancelRef.current || quotaRefreshing) return;
      if (!reason) {
        replyTimingRef.current?.finish('cancelled');
        observationRef.current?.unavailable('cancelled');
      }
      const cancellation = Symbol('cancel');
      cancelRef.current = cancellation;
      setCancelling(true);
      setStreamError(reason ? FIRST_TOKEN_RETRY_MESSAGE : null);
      const isCurrent = () =>
        cancelRef.current === cancellation && sessionRef.current === sessionId;
      try {
        const pending = pendingRef.current?.sessionId === sessionId ? pendingRef.current : null;
        let message = pending
          ? findPendingTurnMessage(persistedMessages, pending)
          : persistedMessages.find(
              (item) => item.role === 'assistant' && item.status === 'streaming'
            );
        let assistantMessageId = pending?.assistantMessageId ?? message?.id;
        // 保留一次点击的取消意图，覆盖开轮/取消 RPC 的确认延迟；总发现等待最多 30 秒。
        const discoveryDeadline = Date.now() + CANCEL_DISCOVERY_DEADLINE_MS;
        while (!assistantMessageId && pending && Date.now() < discoveryDeadline) {
          if (!isCurrent()) return;
          if (pending.unaccepted) {
            // 明确拒绝且未开轮时无可取消的服务端消息，恢复原输入并结束等待。
            if (streaming?.mode === 'send' && streaming.userMessage)
              onRestoreSendContent(streaming.userMessage.content);
            setStreaming(dropCurrentStreamingTurn);
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
                          (item) =>
                            item.role === 'user' && item.turn_index === discovered.turn_index
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
          setStreaming(dropCurrentStreamingTurn);
          setStreamError('本次回复未开始，原消息已保留');
          return;
        }
        if (!assistantMessageId) throw new Error('本次回复尚未确认，请稍后重试取消');
        if (message) observationRef.current?.identify(assistantMessageId, message.revision);
        const result = await cancelTurn({
          sessionId,
          assistantMessageId,
          reason: reason ?? 'user_stop',
        });
        observationRef.current?.identify(result.message.id, result.message.revision);
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
        setStreaming(dropCurrentStreamingTurn);
        setQuotaRefreshing(false);
        safelyRunTelemetry(() => getReplayLifecycle().setStreaming(false));
        void queryClient.invalidateQueries({ queryKey: paymentKeys.wallet() });
        void queryClient.invalidateQueries({ queryKey: freeQuotaKeys.detail(characterId) });
      } catch (error) {
        if (isCurrent())
          setStreamError(error instanceof Error ? error.message : '取消失败，请重试');
      } finally {
        if (isCurrent()) {
          cancelRef.current = null;
          setCancelling(false);
        }
      }
    },
    [
      cancelTurn,
      characterId,
      persistedMessages,
      onRestoreSendContent,
      queryClient,
      quotaRefreshing,
      sessionId,
      streaming,
    ]
  );

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
    streaming: activeStreaming,
    thinkingByMessage,
  };
}
