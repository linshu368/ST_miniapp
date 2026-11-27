/**
 * 读一路上游 SSE 流给用户（首发胜出那一路，或出字后兜底那一路），同时用我们自己的规则判断它是否出了问题：
 *
 * - 卡顿：连续 stallMs 没有新的可见增量（正文或已显示的思考）就掐断，记 stalled。用户定的规则：
 *   卡住的当下分不清「断了」还是「很慢」，一律按中断处理，接受误判。
 * - 拒答：正文照常实时输出（用户定：允许用户看到拒答内容），只在前 checkChars 个字里找词池关键词，
 *   命中当场判拒答、掐断这一路；之后由兜底擦掉重写。
 * - 上游报错（错误块、content_filter / error 结束原因）：收到就当场掐断，不等上游关流
 *   （用户定：有报错就别让用户白等）。其他非正常结束、没有 [DONE] 就断开，等流结束时判。谁先到算谁。
 * - 已经正常写完（stop 或 [DONE]）只是上游迟迟不关流：到 stallMs 按写完处理，不当卡顿擦掉完整回复。
 *
 * 这里只读流和判定，不结算、不发兜底；结束方式见 StreamEnd。
 */
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createSseTap, type SseTapResult } from './upstream.js';
import type { StreamEnd } from './call-ledger.js';

export interface RefusalRule {
  checkChars: number;
  keywords: string[];
}

export interface StreamPass {
  result: SseTapResult;
  end: StreamEnd;
  /** 读流抛出的错误（我方主动掐断的卡顿/拒答不算） */
  error: unknown;
  /** 相邻两次可见增量的最大间隔，用来回看卡顿阈值误伤了多少正常回复 */
  maxGapMs: number;
  /** 最后一次可见增量到判定结束的间隔：上游断在哪、用户白等了多久 */
  tailGapMs: number;
  /** 拒答关键词命中过（含命中后因未成年人而不掐断的情况） */
  refusalHit: boolean;
}

/** 正文前 checkChars 个字里找拒答关键词（子串、不区分大小写）；只判定，不影响输出。 */
export function createRefusalDetector(rule: RefusalRule) {
  const keywords = rule.keywords.map((item) => item.toLowerCase()).filter(Boolean);
  let seen = '';
  let state: 'checking' | 'clear' | 'refused' = 'checking';
  const decide = (final: boolean) => {
    const text = seen.toLowerCase();
    if (keywords.some((keyword) => text.includes(keyword))) state = 'refused';
    else if (final || seen.trimStart().length >= rule.checkChars) state = 'clear';
  };
  return {
    push(text: string): typeof state {
      if (state === 'checking') {
        seen += text;
        decide(false);
      }
      return state;
    },
    /** 流结束时还没看满 checkChars 个字：按已看到的判 */
    settle(): typeof state {
      if (state === 'checking') decide(true);
      return state;
    },
    get seen(): string {
      return seen;
    },
  };
}

export function createStallWatchdog(stallMs: number | null, onStall: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: number | null = null;
  let maxGap = 0;
  let tailGap = 0;
  const arm = () => {
    clearTimeout(timer);
    if (stallMs !== null) timer = setTimeout(onStall, stallMs);
  };
  return {
    start(): void {
      last = performance.now();
      arm();
    },
    touch(): void {
      const now = performance.now();
      if (last !== null) maxGap = Math.max(maxGap, now - last);
      last = now;
      arm();
    },
    stop(): void {
      clearTimeout(timer);
      if (last === null) return;
      tailGap = performance.now() - last;
      maxGap = Math.max(maxGap, tailGap);
    },
    get maxGapMs(): number {
      return Math.round(maxGap);
    },
    get tailGapMs(): number {
      return Math.round(tailGap);
    },
  };
}

/** 正文已经正常写完：有 stop，或没给结束原因但见到了 [DONE]；有错误块、声明截断的不算 */
function finishedNormally(result: SseTapResult, truncated: boolean): boolean {
  if (result.streamError || truncated) return false;
  return result.finishReason === 'stop' || (result.completed && result.finishReason === null);
}

function classifyEnd(
  input: { signal: AbortSignal; outputCap: AbortSignal; error: unknown },
  flags: {
    refused: boolean;
    stalled: boolean;
    firstTokenMissed: boolean;
    /** 收到上游报错后我方当场掐断 */
    failed: boolean;
    truncated: boolean;
  },
  result: SseTapResult
): StreamEnd {
  if (input.signal.aborted) return 'cancelled';
  if (input.outputCap.aborted) return 'output_cap';
  if (flags.refused) return 'refused';
  if (flags.stalled || flags.firstTokenMissed) return 'stalled';
  // 当场掐断时通常还没读到 [DONE]：按报错本身归类，不算断开
  if (!flags.failed && (input.error || !result.completed)) return 'disconnected';
  if (result.streamError || flags.truncated) return 'stream_error';
  if (result.finishReason === null || result.finishReason === 'stop') return 'completed';
  if (result.finishReason === 'length') return 'length';
  if (result.finishReason === 'content_filter') return 'content_filter';
  return 'provider_error';
}

/** 把上游字节流灌进 tap；返回读流中途的错误（没有则 undefined），不抛出。 */
async function pump(
  body: ReadableStream<Uint8Array>,
  tap: ReturnType<typeof createSseTap>,
  signal: AbortSignal
): Promise<unknown> {
  try {
    await pipeline(
      Readable.fromWeb(body as import('stream/web').ReadableStream),
      tap,
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
      { signal }
    );
    return undefined;
  } catch (err) {
    return err;
  }
}

export async function runStreamPass(input: {
  body: ReadableStream<Uint8Array>;
  /** 本轮的中止信号（用户停止、执行截止） */
  signal: AbortSignal;
  /** 我方 5400 字上限 */
  outputCap: AbortSignal;
  generationId: string | null;
  onGenerationId?: (generationId: string) => Promise<void>;
  onContent(text: string): void;
  /** 只有思考过程要显示给用户时才传 */
  onReasoning?: (text: string) => void;
  /** null：不做卡顿判定（只记最大间隔），上游报错也不提前掐断 */
  stallMs: number | null;
  refusal: RefusalRule | null;
  /** 拒答命中时：true 不掐断、照常输出（例如涉及未成年人），缺省掐断 */
  keepOnRefusal?: (seen: string) => boolean;
  /**
   * 兜底那一路：signal 触发时还没出字就放弃；第一次出字时调用 onFirstOutput 撤掉时限。首发已出过字，不传。
   * 「出字」与首发同口径：正文，或要显示给用户的思考（传了 onReasoning 才算）。
   */
  firstToken?: { signal: AbortSignal; onFirstOutput(): void };
  /** Surplus 响应头声明了截断 */
  truncated?: boolean;
}): Promise<StreamPass> {
  const stall = new AbortController();
  const refusal = new AbortController();
  const upstreamFailed = new AbortController();
  const watchdog = createStallWatchdog(input.stallMs, () => stall.abort());
  let refusalHit = false;
  let outputSeen = false;
  const detector = input.refusal?.keywords.length ? createRefusalDetector(input.refusal) : null;
  const noteOutput = (delta: string) => {
    if (outputSeen || !delta.trim()) return;
    outputSeen = true;
    if (input.firstToken) {
      input.firstToken.onFirstOutput();
      watchdog.start();
    }
  };
  const progress = () => {
    // 兜底那一路的卡顿计时从第一次出字开始，之前由首字时限管。
    if (!outputSeen && input.firstToken) return;
    watchdog.touch();
  };
  if (!input.firstToken) watchdog.start();
  const onRefused = () => {
    refusalHit = true;
    if (!input.keepOnRefusal?.(detector?.seen ?? '')) refusal.abort();
  };
  const tap = createSseTap({
    generationId: input.generationId,
    onGenerationId: input.onGenerationId,
    onReasoningDelta: input.onReasoning
      ? (delta) => {
          noteOutput(delta);
          progress();
          input.onReasoning?.(delta);
        }
      : undefined,
    onDelta: (delta) => {
      noteOutput(delta);
      progress();
      input.onContent(delta);
      if (detector && !refusalHit && detector.push(delta) === 'refused') onRefused();
    },
    onFailed: input.stallMs === null ? undefined : () => upstreamFailed.abort(),
    onEnd: () => undefined,
  });

  const caught = await pump(
    input.body,
    tap,
    AbortSignal.any([
      input.signal,
      input.outputCap,
      stall.signal,
      refusal.signal,
      upstreamFailed.signal,
      ...(input.firstToken ? [input.firstToken.signal] : []),
    ])
  );
  watchdog.stop();
  // 我方主动掐断的（卡顿、拒答、收到上游报错）不算读流错误
  const cutByUs = [stall, refusal, upstreamFailed].some(({ signal }) => signal.aborted);
  const error: unknown = cutByUs ? undefined : caught;

  // 流在看满 checkChars 个字之前就结束（或断开）：按已看到的判；用户已停止的不再判。
  if (
    detector &&
    !refusalHit &&
    !input.signal.aborted &&
    !input.outputCap.aborted &&
    detector.settle() === 'refused'
  )
    onRefused();

  const snapshot = tap.snapshot();
  const truncated = input.truncated ?? false;
  const lateClose = stall.signal.aborted && finishedNormally(snapshot, truncated);
  const result = lateClose ? { ...snapshot, completed: true } : snapshot;
  return {
    result,
    end: classifyEnd(
      { signal: input.signal, outputCap: input.outputCap, error },
      {
        refused: refusalHit && refusal.signal.aborted,
        // 报错与卡顿撞在一起按报错算：内容过滤不能当成卡顿绕过未成年人判断
        stalled: stall.signal.aborted && !lateClose && !upstreamFailed.signal.aborted,
        firstTokenMissed: Boolean(input.firstToken?.signal.aborted && !outputSeen),
        failed: upstreamFailed.signal.aborted,
        truncated,
      },
      result
    ),
    error,
    maxGapMs: watchdog.maxGapMs,
    tailGapMs: watchdog.tailGapMs,
    refusalHit,
  };
}
