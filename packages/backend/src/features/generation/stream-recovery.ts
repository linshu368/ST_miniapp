/**
 * 出字后兜底：首发出字后被判中断或拒答（判定见 stream-pass.ts）时，兜底模型按原 messages 从头重写一次。
 * 用户定：不续写，已显示的思考过程和半段正文全部擦掉，相当于重新调用一次兜底模型。
 *
 * - 擦除时机：兜底的第一段正文要发出时才通知客户端清空（onReset），之后输出重写内容。
 *   兜底没出字就失败时不擦，用户已看到的保持不变、按中断结算。
 * - 兜底 fallback_first_token_ms 内没出第一个字就放弃；兜底不再兜底（用户定）。重写不显示思考过程。
 * - 兜底这一路不再做拒答检测（兜底不再兜底），写出什么就交付什么。
 * - 未成年人：卡顿、断开、报错这类技术故障不做任何判断，交给供应商。只有供应商自己拒绝或内容过滤
 *   （refused、content_filter）且涉及未成年人时，不自动换模型重试——那等于专门绕开供应商对未成年人内容的拒绝。
 *
 * 救回来的轮次按正常一轮扣费（用户定）；没救回来的与原来的中断一样免扣。
 */
import { randomUUID } from 'node:crypto';
import type { ChatRecoveryConfig } from '@miniapp/shared';
import type { RecoveryForward } from './generation-dispatch.js';
import { runStreamPass, type RefusalRule, type StreamPass } from './stream-pass.js';
import { insertLlmCall, recordStreamEnd, type StreamEnd } from './call-ledger.js';
import type { GenerationLogger, GenerationRequest } from './types.js';
import type { SseTapResult } from './upstream.js';

/** 未成年人：明确词 + 1–17 岁（阿拉伯数字或中文数字；前面带数字的不算，避免「二十岁」「27岁」误中） */
const MINOR_PATTERN =
  /未成年|小学生|初中生|幼女|幼童|女童|男童|萝莉|正太|(?<![0-9])(?:1[0-7]|[1-9])岁|(?<![一二三四五六七八九十百])(?:十[一二三四五六七]?|[一二三四五六七八九])岁/;

export function involvesMinor(texts: Array<string | null | undefined>): boolean {
  return texts.some((text) => Boolean(text && MINOR_PATTERN.test(text)));
}

const INTERRUPTIONS: ReadonlySet<StreamEnd> = new Set([
  'stalled',
  'stream_error',
  'content_filter',
  'provider_error',
  'disconnected',
]);
/** 与 turn-control 的执行上限一致；剩余不足 MIN_REMAINING_MS 不再发兜底 */
const EXECUTION_LIMIT_MS = 110_000;
const MIN_REMAINING_MS = 20_000;

export interface RecoveryRules {
  /** null：中断兜底关闭，也不做卡顿判定 */
  interruption: { stallMs: number } | null;
  /** null：拒答兜底关闭，正文不压 */
  refusal: RefusalRule | null;
  fallbackFirstTokenMs: number;
}

export function toRecoveryRules(config: ChatRecoveryConfig | null): RecoveryRules {
  return {
    interruption: config?.interruption.enabled ? { stallMs: config.interruption.stall_ms } : null,
    refusal:
      config?.refusal.enabled && config.refusal.keywords.length > 0
        ? { checkChars: config.refusal.check_chars, keywords: config.refusal.keywords }
        : null,
    fallbackFirstTokenMs: config?.fallback_first_token_ms ?? 3_000,
  };
}

/**
 * 最近一来一回（上一条回复与本轮用户原话）：未成年人判断的上下文。
 * 不看最后一条 user 消息：平台规则（含未成年人限制的文字）被包在里面（engine wrapUserInput），一看必中。
 */
export function recentDialogue(request: Pick<GenerationRequest, 'messages' | 'userInput'>) {
  const lastReply = [...request.messages].reverse().find((message) => message.role === 'assistant');
  return [lastReply?.content ?? '', request.userInput];
}

export type RecoveryPlan =
  | { mode: 'rewrite'; trigger: StreamEnd }
  | { skip: 'disabled' | 'minor_guard' | 'deadline' | 'unavailable'; trigger: StreamEnd };

export function planRecovery(input: {
  pass: StreamPass;
  rules: RecoveryRules;
  dialogue: string[];
  elapsedMs: number;
  available: boolean;
}): RecoveryPlan | null {
  const trigger = input.pass.end;
  const refused = trigger === 'refused';
  if (!refused && !INTERRUPTIONS.has(trigger)) return null;
  if (refused ? !input.rules.refusal : !input.rules.interruption)
    return { skip: 'disabled', trigger };
  if (!input.available) return { skip: 'unavailable', trigger };
  if (EXECUTION_LIMIT_MS - input.elapsedMs < MIN_REMAINING_MS) return { skip: 'deadline', trigger };
  // 拒答在命中时已判过（stream-pass keepOnRefusal）；内容过滤在这里判。其余技术故障不判。
  if (trigger === 'content_filter' && involvesMinor([input.pass.result.content, ...input.dialogue]))
    return { skip: 'minor_guard', trigger };
  return { mode: 'rewrite', trigger };
}

export type RecoveryCallEnd =
  | 'completed'
  | 'first_token_deadline'
  | 'upstream_error'
  | 'stream_interrupted'
  | 'refused'
  | 'cancelled';

export interface RecoveryOutcome {
  pass: StreamPass | null;
  callEnd: RecoveryCallEnd;
  httpStatus: number | null;
  /** Surplus 请求号（响应头 x-si-request-id）：Surplus 重写的成本按它补查 */
  requestId?: string | null;
  firstTokenMs: number | null;
  durationMs: number;
  /** 已经通知客户端擦掉原来的内容（兜底至少发出过一段正文） */
  reset: boolean;
}

function callEndOf(pass: StreamPass, firstTokenMs: number | null): RecoveryCallEnd {
  if (pass.end === 'completed') return 'completed';
  if (pass.end === 'cancelled') return 'cancelled';
  if (pass.end === 'refused') return 'refused';
  if (firstTokenMs === null && pass.end === 'stalled') return 'first_token_deadline';
  return 'stream_interrupted';
}

export async function runRecovery(input: {
  trigger: StreamEnd;
  request: GenerationRequest;
  rules: RecoveryRules;
  forward: RecoveryForward;
  signal: AbortSignal;
  outputCap: AbortSignal;
  onContent(text: string): void;
  /** 兜底第一段正文发出前调用一次：客户端擦掉这条回复已显示的正文与思考 */
  onReset(): void;
  ledger: { chatHistoryId: string; lane: 'chat' | 'free_zone'; candidateId: string | null } | null;
  log: GenerationLogger;
}): Promise<RecoveryOutcome> {
  let reset = false;
  const onContent = (text: string) => {
    if (!reset) {
      reset = true;
      input.onReset();
    }
    input.onContent(text);
  };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), input.rules.fallbackFirstTokenMs);
  const startedAt = performance.now();
  const dispatchedAt = new Date().toISOString();
  let firstTokenMs: number | null = null;
  let outcome: Omit<RecoveryOutcome, 'durationMs' | 'reset'>;
  try {
    const response = await input.forward.send(
      input.request.messages,
      AbortSignal.any([input.signal, deadline.signal])
    );
    const requestId = response.headers.get('x-si-request-id');
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      outcome = {
        pass: null,
        callEnd: 'upstream_error',
        httpStatus: response.status,
        requestId,
        firstTokenMs,
      };
    } else {
      const pass = await runStreamPass({
        body: response.body,
        signal: input.signal,
        outputCap: input.outputCap,
        generationId: null,
        onContent,
        stallMs: input.rules.interruption?.stallMs ?? null,
        refusal: null,
        firstToken: {
          signal: deadline.signal,
          onFirstContent: () => {
            clearTimeout(timer);
            firstTokenMs = performance.now() - startedAt;
          },
        },
      });
      outcome = {
        pass,
        callEnd: callEndOf(pass, firstTokenMs),
        httpStatus: response.status,
        requestId,
        firstTokenMs,
      };
    }
  } catch {
    outcome = {
      pass: null,
      callEnd: input.signal.aborted
        ? 'cancelled'
        : deadline.signal.aborted
          ? 'first_token_deadline'
          : 'upstream_error',
      httpStatus: null,
      firstTokenMs,
    };
  } finally {
    clearTimeout(timer);
  }
  const result = { ...outcome, reset, durationMs: Math.round(performance.now() - startedAt) };
  recordRecoveryCall(input, result, dispatchedAt);
  return result;
}

function recordRecoveryCall(
  input: Parameters<typeof runRecovery>[0],
  outcome: RecoveryOutcome,
  dispatchedAt: string
): void {
  if (!input.ledger) return;
  const callId = randomUUID();
  const end = outcome.pass?.end;
  void insertLlmCall({
    ...input.ledger,
    callId,
    attemptId: callId,
    ownsAttempt: () => Promise.resolve(false),
    role: 'rewrite',
    slot: 0,
    provider: input.forward.model.provider,
    providerModelId: input.forward.model.providerModelId,
    dispatchedAt,
    endReason: outcome.callEnd,
    requestId: outcome.requestId ?? null,
    generationId: outcome.pass?.result.generationId ?? null,
    httpStatus: outcome.httpStatus,
  })
    .then(() => {
      if (end) recordStreamEnd({ callId }, end, input.log.sys);
    })
    .catch((err: unknown) =>
      input.log.sys.warn(
        { err, event: 'llm.call_record_failed', historyId: input.ledger?.chatHistoryId },
        '模型调用台账写入失败'
      )
    );
}

function interruptedFinishReason(pass: StreamPass): string | null {
  switch (pass.end) {
    case 'stalled':
      return 'stalled';
    case 'refused':
      return 'refusal';
    case 'stream_error':
      // 流内错误块记 error；只有 Surplus 响应头声明截断时沿用原来的 upstream_truncated
      return pass.result.streamError ? 'error' : 'upstream_truncated';
    default:
      return pass.result.finishReason;
  }
}

/**
 * 没救回来（没救、救不了、兜底失败）时交给结算的结果：一律按中断，落库内容 = 用户屏幕上留着的内容。
 * 兜底已擦掉原内容并输出过一部分 → 保留兜底这部分；没擦 → 保留首发的（含拒答原文，用户已看到）。
 */
export function unrecoveredResult(
  primary: StreamPass,
  recovery: RecoveryOutcome | null
): SseTapResult {
  const shown = recovery?.reset && recovery.pass ? recovery.pass : primary;
  return {
    ...primary.result,
    completed: false,
    content: shown.result.content,
    deltaCount: shown.result.deltaCount,
    finishReason: interruptedFinishReason(shown),
  };
}

/** 救回来：落库内容只有重写的正文；交付身份（generationId、用量）沿用首发。 */
export function recoveredResult(primary: StreamPass, recovery: StreamPass): SseTapResult {
  return {
    ...primary.result,
    completed: true,
    content: recovery.result.content,
    deltaCount: recovery.result.deltaCount,
    finishReason: recovery.result.finishReason ?? 'stop',
    streamError: null,
  };
}
