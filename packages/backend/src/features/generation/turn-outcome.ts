/**
 * 每轮聊天两种口径的结果，计入 Grafana 指标 st_chat_turns_total（看板「聊天成功率」）。
 *
 * - outcome：用户最终拿到的（首发 + 首字兜底 + 出字后重写共同作用之后）。
 * - primary_outcome：首发模型自己的表现。超时只算「首字兜底真的替它交付了」或「谁都没出字」；
 *   首发出字前报错、由兜底交付的算报错。
 *
 * 只统计有首字竞速的聊天轮次；余额/VIP 拒绝、用户停止不计入。
 * 拒答按运营词池判正文开头（与出字后兜底同一份词池，开关关着也判），不读、不记正文。
 *
 * 另记兜底那一路自己的结果 st_chat_fallbacks_total（看板「兜底模型」视图）：只记兜底真正决定用户结果的调用——
 * 首字兜底只在首发没交付时记（兜底发出后首发先出字 = 没用上，不记），出字后重写每次真正发出都记。
 */
import {
  observeChatFallback,
  observeChatTurn,
  type ChatFallbackRecord,
  type ChatTurnOutcome,
} from '../../lib/engineering-observability.js';
import type { StreamEnd } from './call-ledger.js';
import type { SettledCall } from './first-token-fallback.js';
import type { RecoveryCallEnd } from './stream-recovery.js';
import { readChatRecoveryConfig } from './chat-recovery-config.js';
import { createRefusalDetector, type RefusalRule } from './stream-pass.js';
import type { GenerationRequest, GenerationResult } from './types.js';

/** 生成过程中陆续记下的事实；execute 出口统一判定 */
export interface TurnFacts {
  /** 首字竞速胜出的一路；没有竞速时出了流就是首发 */
  deliveredRole: 'primary' | 'fallback' | null;
  /** 首发各路（含畅聊并发）的结束原因 */
  primaryCallEnds: string[];
  /** 胜出那一路出字后的结束方式 */
  deliveredEnd: StreamEnd | null;
  /** 出字后兜底重写成功 */
  recovered: boolean;
  /** 首字兜底最后结束的那一次调用（兜底重试时是重试那次）；没发出兜底为 null */
  fallbackCall: FallbackCallFact | null;
  /** 真正发出过的出字后重写；没发出为 null */
  rewrite: RewriteFact | null;
}

export interface FallbackCallFact {
  provider: string;
  model: string;
  endReason: SettledCall['endReason'];
  httpStatus: number | null;
  preTokenOutcome: SettledCall['preTokenOutcome'];
}

export interface RewriteFact {
  provider: string;
  model: string;
  /** 触发重写的首发结束方式（中断各类 / refused / content_filter） */
  trigger: StreamEnd;
  callEnd: RecoveryCallEnd;
  /** 重写那一路的流结束方式；出字前就失败的没有 */
  passEnd: StreamEnd | null;
  httpStatus: number | null;
  /** 正常写完且有正文 */
  recovered: boolean;
}

export function createTurnFacts(): TurnFacts {
  return {
    deliveredRole: null,
    primaryCallEnds: [],
    deliveredEnd: null,
    recovered: false,
    fallbackCall: null,
    rewrite: null,
  };
}

export function fallbackCallFact(call: SettledCall): FallbackCallFact {
  return {
    provider: call.provider,
    model: call.providerModelId,
    endReason: call.endReason,
    httpStatus: call.httpStatus,
    preTokenOutcome: call.preTokenOutcome ?? null,
  };
}

const INTERRUPTED: ReadonlySet<StreamEnd> = new Set<StreamEnd>([
  'stalled',
  'stream_error',
  'disconnected',
  'provider_error',
  // 被截断的回复用户看到的也是半段
  'length',
  'output_cap',
]);

function passOutcome(end: StreamEnd, refusedText: boolean): ChatTurnOutcome | null {
  if (end === 'cancelled') return null;
  if (end === 'refused' || end === 'content_filter') return 'refused';
  if (INTERRUPTED.has(end)) return 'interrupted';
  return refusedText ? 'refused' : 'success';
}

/** 首发没交付：各路都是报错 → 报错；否则是没抢到首字 → 超时 */
function primaryLost(facts: TurnFacts): ChatTurnOutcome {
  const ends = facts.primaryCallEnds;
  return ends.length > 0 && ends.every((end) => end === 'upstream_error') ? 'error' : 'timeout';
}

export function refusalHit(text: string, rule: RefusalRule | null): boolean {
  if (!rule || !text) return false;
  const detector = createRefusalDetector(rule);
  detector.push(text.trimStart().slice(0, rule.checkChars));
  return detector.settle() === 'refused';
}

export interface TurnClassification {
  outcome: ChatTurnOutcome;
  primaryOutcome: ChatTurnOutcome;
  rescue: 'none' | 'fallback' | 'rewrite';
}

export function classifyTurn(input: {
  facts: TurnFacts;
  result: GenerationResult | null;
  /** 出字前就结束：首字截止或执行超时 */
  timedOut: boolean;
  cancelled: boolean;
  finalRefused: boolean;
}): TurnClassification | null {
  const { facts, result } = input;
  if (input.cancelled || result?.status === 'insufficient_balance' || result?.denial) return null;
  if (result?.finishReason === 'user_cancelled' || result?.finishReason === 'cancelled')
    return null;
  const role = facts.deliveredRole ?? (facts.deliveredEnd ? 'primary' : null);
  if (!role || !facts.deliveredEnd) {
    const outcome = input.timedOut ? 'timeout' : 'error';
    return {
      outcome,
      primaryOutcome: role === 'fallback' ? primaryLost(facts) : outcome,
      rescue: 'none',
    };
  }
  // 出字后撞上执行总时限：流被我方掐断，读法上是 cancelled，用户看到的是半段
  const end: StreamEnd =
    facts.deliveredEnd === 'cancelled' && input.timedOut ? 'disconnected' : facts.deliveredEnd;
  const outcome = facts.recovered
    ? input.finalRefused
      ? 'refused'
      : 'success'
    : passOutcome(end, input.finalRefused);
  if (!outcome) return null;
  const primaryOutcome =
    role === 'fallback'
      ? primaryLost(facts)
      : passOutcome(end, !facts.recovered && input.finalRefused);
  if (!primaryOutcome) return null;
  return {
    outcome,
    primaryOutcome,
    rescue: facts.recovered ? 'rewrite' : role === 'fallback' ? 'fallback' : 'none',
  };
}

/** 出字前失败的细分：上游状态码（4xx 原样、5xx 合并），流内报错 / 内容过滤 / 撞长度，网络错误 */
function errorReason(call: { httpStatus: number | null; preTokenOutcome?: string | null }): string {
  if (call.preTokenOutcome === 'filtered') return 'content_filter';
  if (call.preTokenOutcome === 'length') return 'length';
  const status = call.httpStatus;
  if (status === null) return 'network';
  if (status >= 500) return 'http_5xx';
  if (status >= 400) return `http_${status}`;
  return 'stream_error';
}

/** 首发没交付时，首字兜底那一路的结果；首发交付了（没用上）或兜底没发出返回 null */
function firstTokenFallback(
  facts: TurnFacts,
  timedOut: boolean,
  finalRefused: boolean
): ChatFallbackRecord | null {
  const call = facts.fallbackCall;
  const role = facts.deliveredRole ?? (facts.deliveredEnd ? 'primary' : null);
  if (!call || role === 'primary') return null;
  const head = {
    kind: 'first_token' as const,
    trigger:
      primaryLost(facts) === 'error' ? ('primary_error' as const) : ('primary_timeout' as const),
    provider: call.provider,
    model: call.model,
  };
  if (role === 'fallback' && facts.deliveredEnd) {
    // 被重写救回时，兜底自己是在触发重写的那一下失败的
    const outcome = passOutcome(facts.deliveredEnd, !facts.recovered && finalRefused);
    if (!outcome) return null;
    const reason =
      outcome === 'success'
        ? 'none'
        : outcome === 'refused' && facts.deliveredEnd !== 'content_filter'
          ? 'refusal_words'
          : facts.deliveredEnd;
    return { ...head, outcome, reason };
  }
  switch (call.endReason) {
    case 'upstream_error':
    case 'stream_interrupted':
      return { ...head, outcome: 'error', reason: errorReason(call) };
    case 'first_token_deadline':
      return { ...head, outcome: 'timeout', reason: 'first_token_deadline' };
    case 'cancelled':
      // 用户停止已在上面排除；剩下是撞执行总时限被我方掐断
      return timedOut ? { ...head, outcome: 'timeout', reason: 'first_token_deadline' } : null;
    default:
      // 兜底出了字却没交付成（交付写库失败等）
      return { ...head, outcome: 'error', reason: 'delivery_failed' };
  }
}

const REWRITE_ENDS: Partial<Record<RecoveryCallEnd, ChatTurnOutcome>> = {
  refused: 'refused',
  first_token_deadline: 'timeout',
  upstream_error: 'error',
  stream_interrupted: 'interrupted',
};

function rewriteFallback(facts: TurnFacts, finalRefused: boolean): ChatFallbackRecord | null {
  const rewrite = facts.rewrite;
  if (!rewrite || rewrite.callEnd === 'cancelled') return null;
  const head = {
    kind: 'rewrite' as const,
    trigger:
      rewrite.trigger === 'refused' || rewrite.trigger === 'content_filter'
        ? ('refused' as const)
        : ('interrupted' as const),
    provider: rewrite.provider,
    model: rewrite.model,
  };
  if (rewrite.recovered)
    return finalRefused
      ? { ...head, outcome: 'refused', reason: 'refusal_words' }
      : { ...head, outcome: 'success', reason: 'none' };
  if (rewrite.passEnd === 'content_filter')
    return { ...head, outcome: 'refused', reason: 'content_filter' };
  const outcome = REWRITE_ENDS[rewrite.callEnd] ?? 'error';
  const reason =
    outcome === 'error'
      ? rewrite.callEnd === 'completed'
        ? 'empty'
        : errorReason(rewrite)
      : outcome === 'timeout'
        ? 'first_token_deadline'
        : outcome === 'refused'
          ? 'refusal_words'
          : (rewrite.passEnd ?? 'stream_error');
  return { ...head, outcome, reason };
}

/** 这一轮里真正决定用户结果的兜底调用（0–2 条：首字兜底、出字后重写） */
export function classifyFallbacks(input: {
  facts: TurnFacts;
  timedOut: boolean;
  cancelled: boolean;
  finalRefused: boolean;
  result: GenerationResult | null;
}): ChatFallbackRecord[] {
  const { result } = input;
  if (input.cancelled || result?.status === 'insufficient_balance' || result?.denial) return [];
  if (result?.finishReason === 'user_cancelled' || result?.finishReason === 'cancelled') return [];
  return [
    firstTokenFallback(input.facts, input.timedOut, input.finalRefused),
    rewriteFallback(input.facts, input.finalRefused),
  ].filter((record): record is ChatFallbackRecord => record !== null);
}

/** execute 出口调用，不阻塞返回；任何异常只丢这一条计数 */
export async function recordChatTurn(input: {
  request: GenerationRequest;
  facts: TurnFacts;
  result: GenerationResult | null;
  timedOut: boolean;
  cancelled: boolean;
}): Promise<void> {
  try {
    const config = await readChatRecoveryConfig();
    const rule = config?.refusal.keywords.length
      ? { checkChars: config.refusal.check_chars, keywords: config.refusal.keywords }
      : null;
    const finalRefused = refusalHit(input.result?.content ?? '', rule);
    const classified = classifyTurn({ ...input, finalRefused });
    if (!classified) return;
    const { model } = input.request;
    const lane = model.billingContext?.freeZone?.candidateId ? 'free_zone' : 'chat';
    observeChatTurn({
      provider: model.provider,
      model: model.providerModelId,
      lane,
      ...classified,
    });
    for (const record of classifyFallbacks({ ...input, finalRefused }))
      observeChatFallback({ ...record, lane });
  } catch {
    // 指标丢一条不影响对话
  }
}
