/**
 * 右侧面板（状态栏 / 记忆栏）质量漏斗的归因：把一次尝试、一次更新归到"停在哪层、主因是什么"，
 * 交给工程遥测计数（Grafana）。只读校验结果、不改任何业务结论；口径见任务 11-24-panel-quality-monitor。
 */
import {
  statusCarriedItems,
  type MemoryBarApplyResult,
  type StatusBarTemplate,
  type StatusItemOutcome,
  type StatusValidation,
} from '@miniapp/shared';
import {
  observePanelAttempt,
  observePanelUpdate,
  observeStatusItems,
  type PanelAttemptStage,
  type PanelTrigger,
} from '../../lib/panel-quality-telemetry.js';
import type { StatusModelChannel, StatusModelError } from '../generation/status-bar-model.js';

/** 模型调用失败时进 pino 的字段：错误码 + 没写完时的原始结束原因（都在 safe-log 白名单里，不含正文）。 */
export function modelErrorFields(error: StatusModelError) {
  const s = error.signals;
  return {
    error_code: error.code,
    ...(s?.finishReason ? { finish_reason: s.finishReason } : {}),
    ...(s?.nativeFinishReason ? { native_finish_reason: s.nativeFinishReason } : {}),
    ...(s?.streamError ? { stream_error: s.streamError } : {}),
  };
}

/** 尝试层的先后：更新失败时归到走得最远的那一层（拿到过输出就不算模型层）。 */
const DEPTH: Record<PanelAttemptStage, number> = { model: 0, format: 1, content: 2, ok: 3 };

const furthest = (stages: PanelAttemptStage[]): PanelAttemptStage =>
  stages.reduce((a, b) => (DEPTH[b] > DEPTH[a] ? b : a), 'model');

// ── 状态栏 ────────────────────────────────────────────────────────────────

export interface StatusAttemptLike {
  channel: StatusModelChannel;
  validation: StatusValidation | null;
  error: StatusModelError | null;
}

export function statusAttemptStage(attempt: StatusAttemptLike): PanelAttemptStage {
  return attempt.validation?.stage ?? 'model';
}

/** content/format 层的主因（有界枚举）；按对显示影响从大到小取第一个。 */
function statusProblem(v: StatusValidation): string {
  if (v.stage === 'format') return v.expectedCount === 0 ? 'legacy' : 'no_fields';
  const p = v.problems;
  if (p.missing) return 'missing';
  if (p.badFormat.length) return 'bad_format';
  if (p.placeholderTitle) return 'placeholder';
  if (p.extraGroups) return 'extra_groups';
  if (p.strayLines) return 'stray_lines';
  return v.items.some((item) => item.result === 'carried') ? 'groups_missing' : 'none';
}

export function reportStatusAttempt(trigger: PanelTrigger, attempt: StatusAttemptLike): void {
  const v = attempt.validation;
  observePanelAttempt({
    panel: 'status',
    channel: attempt.channel,
    trigger,
    stage: statusAttemptStage(attempt),
    problem: v && v.stage !== 'ok' ? statusProblem(v) : 'none',
    errorCode: attempt.error?.code ?? 'none',
  });
}

export interface StatusItemCounts {
  freshCount: number;
  emptyCount: number;
  kindMismatchCount: number;
  carriedCount: number;
}

export function countStatusItems(items: StatusItemOutcome[]): StatusItemCounts {
  const n = (result: StatusItemOutcome['result']) =>
    items.filter((item) => item.result === result).length;
  return {
    freshCount: n('fresh'),
    emptyCount: n('empty'),
    kindMismatchCount: n('kind_mismatch'),
    carriedCount: n('carried'),
  };
}

/**
 * 一次状态更新的终态。recorded=false 时 stage 取 store（写库抛错）或两次尝试走得最远的层；
 * 落库后按面板上的逐项结果：有沿用 → content，只有显示错位 → display，否则 perfect。
 */
export function reportStatusUpdate(input: {
  trigger: PanelTrigger;
  template: StatusBarTemplate;
  attempts: StatusAttemptLike[];
  best: StatusAttemptLike;
  recorded: boolean;
  storeFailed?: boolean;
}): StatusItemCounts {
  const items =
    input.recorded && input.best.validation
      ? input.best.validation.items
      : statusCarriedItems(input.template);
  const counts = countStatusItems(items);
  const { result, stage } = input.recorded
    ? counts.carriedCount
      ? { result: 'degraded', stage: 'content' }
      : counts.kindMismatchCount
        ? { result: 'degraded', stage: 'display' }
        : { result: 'perfect', stage: 'ok' }
    : {
        result: 'failed',
        stage: input.storeFailed ? 'store' : furthest(input.attempts.map(statusAttemptStage)),
      };
  observePanelUpdate({
    panel: 'status',
    trigger: input.trigger,
    result,
    stage,
    channel: input.recorded || input.storeFailed ? input.best.channel : 'none',
  });
  observeStatusItems({ trigger: input.trigger, items });
  return counts;
}

// ── 记忆栏 ────────────────────────────────────────────────────────────────

export interface MemoryAttemptLike {
  channel: StatusModelChannel;
  result: MemoryBarApplyResult | null;
  error: StatusModelError | null;
}

export function memoryAttemptStage(attempt: MemoryAttemptLike): PanelAttemptStage {
  if (!attempt.result) return 'model';
  return attempt.result.ok ? 'ok' : attempt.result.stage;
}

export function reportMemoryAttempt(trigger: PanelTrigger, attempt: MemoryAttemptLike): void {
  const r = attempt.result;
  observePanelAttempt({
    panel: 'memory',
    channel: attempt.channel,
    trigger,
    stage: memoryAttemptStage(attempt),
    problem: r && !r.ok ? (r.problems[0] ?? 'none') : 'none',
    errorCode: attempt.error?.code ?? 'none',
  });
}

/**
 * 一次记忆检查的终态。result：recorded / no_progress（模型判断没进展，按设计是正常结果）/
 * conflict（别的检查先写了，放弃本次）/ failed。失败时 stage 取 store（写库抛错）或走得最远的层。
 */
export function reportMemoryUpdate(input: {
  trigger: PanelTrigger;
  attempts: MemoryAttemptLike[];
  best: MemoryAttemptLike;
  result: 'recorded' | 'no_progress' | 'conflict' | 'failed';
  storeFailed?: boolean;
}): void {
  const stage =
    input.result === 'failed'
      ? input.storeFailed
        ? 'store'
        : furthest(input.attempts.map(memoryAttemptStage))
      : input.result === 'conflict'
        ? 'store'
        : 'ok';
  observePanelUpdate({
    panel: 'memory',
    trigger: input.trigger,
    result: input.result,
    stage,
    channel: input.result === 'failed' && !input.storeFailed ? 'none' : input.best.channel,
  });
}
