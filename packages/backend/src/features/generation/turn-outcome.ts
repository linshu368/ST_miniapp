/**
 * 每轮聊天两种口径的结果，计入 Grafana 指标 st_chat_turns_total（看板「聊天成功率」）。
 *
 * - outcome：用户最终拿到的（首发 + 首字兜底 + 出字后重写共同作用之后）。
 * - primary_outcome：首发模型自己的表现。超时只算「首字兜底真的替它交付了」或「谁都没出字」；
 *   首发出字前报错、由兜底交付的算报错。
 *
 * 只统计有首字竞速的聊天轮次；余额/VIP 拒绝、用户停止不计入。
 * 拒答按运营词池判正文开头（与出字后兜底同一份词池，开关关着也判），不读、不记正文。
 */
import { observeChatTurn, type ChatTurnOutcome } from '../../lib/engineering-observability.js';
import type { StreamEnd } from './call-ledger.js';
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
}

export function createTurnFacts(): TurnFacts {
  return { deliveredRole: null, primaryCallEnds: [], deliveredEnd: null, recovered: false };
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
    const classified = classifyTurn({
      ...input,
      finalRefused: refusalHit(input.result?.content ?? '', rule),
    });
    if (!classified) return;
    const { model } = input.request;
    observeChatTurn({
      provider: model.provider,
      model: model.providerModelId,
      lane: model.billingContext?.freeZone?.candidateId ? 'free_zone' : 'chat',
      ...classified,
    });
  } catch {
    // 指标丢一条不影响对话
  }
}
