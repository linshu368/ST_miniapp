/**
 * 正文字数双水位。纯函数：输入是本轮已经读出来的窗口内轮次，不额外读库。
 *
 * 超过高水位 U 才动，一次退到低水位 L 以下，之后在回到 U 之前窗口不再移动，
 * 前缀保持稳定（prompt cache 友好）。最近 minKeepTurns 轮永不移除。
 */
import type { StoryMemoryConfig } from '@miniapp/shared';

export interface WindowTurnSize {
  turnIndex: number;
  chars: number;
}

export interface ContextWindowPlan {
  startTurn: number;
  advanced: boolean;
  totalChars: number;
  removedTurns: number;
  removedChars: number;
  /** 超过 U 但保底之外可移除的轮数不足，只能超出 */
  floorBinding: boolean;
}

type WindowLimits = Pick<
  StoryMemoryConfig,
  'high_watermark_chars' | 'low_watermark_chars' | 'min_keep_turns' | 'min_removable_turns'
>;

export function planContextWindow(input: {
  /** 按 turnIndex 升序，只含窗口内的轮次（不含本轮、不含开场白） */
  turns: WindowTurnSize[];
  currentInputChars: number;
  currentStart: number;
  limits: WindowLimits;
}): ContextWindowPlan {
  const { turns, limits } = input;
  const currentStart = Math.max(input.currentStart, 1);
  const totalChars = turns.reduce((sum, turn) => sum + turn.chars, input.currentInputChars);
  const unchanged = {
    startTurn: currentStart,
    advanced: false,
    totalChars,
    removedTurns: 0,
    removedChars: 0,
  };
  if (totalChars <= limits.high_watermark_chars) return { ...unchanged, floorBinding: false };

  const removable = turns.slice(0, Math.max(turns.length - limits.min_keep_turns, 0));
  if (removable.length < limits.min_removable_turns) return { ...unchanged, floorBinding: true };

  let remaining = totalChars;
  let removedTurns = 0;
  for (const turn of removable) {
    if (remaining <= limits.low_watermark_chars) break;
    remaining -= turn.chars;
    removedTurns += 1;
  }
  const firstKept = turns[removedTurns];
  // removable never covers every turn (min_keep_turns ≥ 11), so firstKept exists.
  const startTurn = Math.max(firstKept?.turnIndex ?? currentStart, currentStart);
  return {
    startTurn,
    advanced: startTurn > currentStart,
    totalChars,
    removedTurns,
    removedChars: totalChars - remaining,
    floorBinding: remaining > limits.low_watermark_chars,
  };
}

/**
 * keep：未超高水位。
 * advance：记忆已覆盖要移出的轮次，窗口前移与新记忆在同一轮生效（prompt 前缀只变一次，无空窗）。
 * wait：记忆还没覆盖，先请求后台压缩到 targetEnd，本轮窗口不动（前缀不变，缓存照常命中）。
 * forced：等待期间窗口超过硬上限（压缩迟迟不成功），不再等，直接前移。
 */
export type WindowAction = 'keep' | 'advance' | 'wait' | 'forced';

export interface WindowDecision {
  action: WindowAction;
  startTurn: number;
  /** 需要压缩到的轮次（含）；keep 时为 null */
  targetEnd: number | null;
}

/** 等待压缩期间允许超出高水位的余量：高低水位落差的一半 */
export function hardCapChars(
  limits: Pick<WindowLimits, 'high_watermark_chars' | 'low_watermark_chars'>
) {
  return (
    limits.high_watermark_chars +
    Math.floor((limits.high_watermark_chars - limits.low_watermark_chars) / 2)
  );
}

export function decideContextWindow(input: {
  plan: ContextWindowPlan;
  currentStart: number;
  /** 最新记忆覆盖到的轮次；没有记忆为 0，读取失败或超时为 null */
  coverage: number | null;
  memoryEnabled: boolean;
  limits: Pick<WindowLimits, 'high_watermark_chars' | 'low_watermark_chars'>;
}): WindowDecision {
  const { plan, currentStart } = input;
  if (!plan.advanced) return { action: 'keep', startTurn: currentStart, targetEnd: null };
  const targetEnd = plan.startTurn - 1;
  if (!input.memoryEnabled) return { action: 'advance', startTurn: plan.startTurn, targetEnd };
  if (input.coverage !== null) {
    // Advance only as far as memory already covers; a partially landed job still helps.
    const reachable = Math.min(plan.startTurn, input.coverage + 1);
    if (reachable > currentStart) return { action: 'advance', startTurn: reachable, targetEnd };
  }
  if (plan.totalChars > hardCapChars(input.limits)) {
    return { action: 'forced', startTurn: plan.startTurn, targetEnd };
  }
  return { action: 'wait', startTurn: currentStart, targetEnd };
}
