/**
 * 一次状态更新：读输入 → 主通道 → 不合格/失败转兜底（附问题清单）→ 校验沿用 → 落库 → 记日志。
 *
 * 同一会话同时只跑一次（进程内去重）：手动更新撞上进行中的自动更新，直接等它的结果。
 * 自动更新在回复 done 之后触发，失败只记日志；下一轮回复结束时条件仍满足，会自然再试。
 */
import {
  STATUS_AUTO_UPDATE_EVERY_TURNS,
  STATUS_PROMPT_WINDOW,
  buildStatusPromptMessages,
  splitEditableReply,
  statusInitialText,
  statusRepeatTitleIsName,
  validateStatusOutput,
  type StatusBarTemplate,
  type StatusPromptTurn,
  type StatusValidateOptions,
  type StatusValidation,
} from '@miniapp/shared';
import type {
  StatusPathTurn,
  StatusSnapshotRow,
} from '../../infrastructure/repositories/StatusBarRepository.js';
import type { RequestLogger } from '../../platform/observability/logger.js';
import {
  callStatusModel,
  StatusModelError,
  type StatusModelChannel,
} from '../generation/status-bar-model.js';
import { resolveEffectiveStatusBar, statusRepo, StatusBarError } from './template.js';

export type StatusUpdateOutcome = 'ok' | 'partial' | 'failed' | 'skipped';

export interface StatusUpdateResult {
  outcome: StatusUpdateOutcome;
}

const EARLIER_INPUT_ROWS = 80;
const inFlight = new Map<string, Promise<StatusUpdateResult>>();

export const isStatusUpdating = (sessionId: string) => inFlight.has(sessionId);

interface Attempt {
  channel: StatusModelChannel;
  validation: StatusValidation | null;
  error: StatusModelError | null;
}

const rank = (v: StatusValidation | null) =>
  !v
    ? -1
    : v.outcome === 'ok'
      ? 1_000 + v.matchedCount
      : v.outcome === 'partial'
        ? v.matchedCount
        : -1;

interface CheckInput {
  template: StatusBarTemplate;
  previousText: string | null;
  options: StatusValidateOptions;
}

async function attempt(
  channel: StatusModelChannel,
  build: (issues?: string[]) => { system: string; user: string },
  check: CheckInput,
  issues?: string[]
): Promise<Attempt> {
  try {
    const result = await callStatusModel(channel, build(issues));
    return {
      channel,
      validation: validateStatusOutput(
        check.template,
        result.content,
        check.previousText,
        check.options
      ),
      error: null,
    };
  } catch (error) {
    if (error instanceof StatusModelError) return { channel, validation: null, error };
    throw error;
  }
}

function toPromptTurns(earlier: StatusPathTurn[], recent: StatusPathTurn[]): StatusPromptTurn[] {
  return [
    ...earlier.map((turn) => ({ index: turn.turnIndex, user: turn.userInput, reply: '' })),
    ...recent.map((turn) => ({
      index: turn.turnIndex,
      user: turn.userInput,
      // 旧消息里可能还带着选项/状态/记忆尾巴，只喂正文。
      reply: splitEditableReply(turn.assistantReply ?? '').body,
    })),
  ];
}

interface UpdateInput {
  userId: string;
  sessionId: string;
  trigger: 'auto' | 'manual';
  log: RequestLogger;
}

async function doUpdate(input: UpdateInput): Promise<StatusUpdateResult> {
  const started = Date.now();
  const repo = statusRepo();
  const session = await repo.readSession(input.sessionId, input.userId);
  if (!session) throw new StatusBarError('STATUS_NOT_FOUND', '对话不存在');
  const effective = await resolveEffectiveStatusBar({
    userId: input.userId,
    characterId: session.characterId,
    sessionId: input.sessionId,
  });
  if (effective.source === 'none')
    throw new StatusBarError('STATUS_DISABLED', '这张卡没有状态栏，或状态栏已关闭');
  const recent = await repo.readRecentTurns(input.sessionId, STATUS_PROMPT_WINDOW.recentTurns);
  const anchor = recent[recent.length - 1];
  if (!anchor) return { outcome: 'skipped' };
  const [earlier, previous] = await Promise.all([
    repo.readEarlierUserInputs(input.sessionId, recent[0]!.turnIndex, EARLIER_INPUT_ROWS),
    repo.readCurrent(input.sessionId),
  ]);
  const template = effective.template;
  const check: CheckInput = {
    template,
    previousText: previous?.text ?? statusInitialText(template),
    // 作者把每人一组的标题直接写成了真名（如【林雪儿】）：照写就对，不要求换名
    options: {
      repeatTitleIsName: statusRepeatTitleIsName(
        template,
        `${effective.character.name}\n${effective.character.description}`
      ),
    },
  };
  const turns = toPromptTurns(earlier, recent);
  const build = (issues?: string[]) =>
    buildStatusPromptMessages({
      // 只给角色名字：不喂正文模型的 system prompt（卡设定、人设、补充设定）。
      character: { name: effective.character.name },
      template,
      previous: previous ? { text: previous.text, anchorTurn: previous.anchorTurn } : null,
      turns,
      retryIssues: issues,
    });
  const first = await attempt('primary', build, check);
  if (first.error)
    input.log.sys.warn(
      { event: 'status_bar.primary.failed', err: first.error, durationMs: Date.now() - started },
      '状态栏主通道失败，转兜底'
    );
  const second =
    first.validation?.outcome === 'ok'
      ? null
      : await attempt(
          'fallback',
          build,
          check,
          first.validation?.issues.length ? first.validation.issues : undefined
        );
  const best = second && rank(second.validation) > rank(first.validation) ? second : first;
  const validation = best.validation;
  const outcome: StatusUpdateOutcome =
    validation && validation.outcome !== 'failed' && validation.text
      ? validation.outcome
      : 'failed';
  if (outcome !== 'failed' && validation?.text) {
    await repo.record({
      sessionId: input.sessionId,
      userId: input.userId,
      anchor,
      text: validation.text,
      source: effective.source,
      trigger: input.trigger,
    });
  }
  logUpdate(input, {
    outcome,
    previous,
    anchor,
    turns,
    best,
    second,
    validation,
    started,
    source: effective.source,
  });
  return { outcome };
}

/** 没过检查的原因：只记类型和数量（safe-log 只放行 *Count 数字和 kind 这类短文本），不记内容。 */
function problemFields(validation: StatusValidation | null) {
  const p = validation?.problems;
  if (!p) return {};
  return {
    missingCount: p.missing,
    badFormatCount: p.badFormat.length,
    // 写法不对的项是哪些样式，如 "stage/stars"
    kind: [...new Set(p.badFormat)].sort().join('/') || 'none',
    placeholderTitleCount: p.placeholderTitle,
    extraGroupCount: p.extraGroups,
    strayLineCount: p.strayLines,
  };
}

function logUpdate(
  input: UpdateInput,
  f: {
    outcome: StatusUpdateOutcome;
    previous: StatusSnapshotRow | null;
    anchor: StatusPathTurn;
    turns: StatusPromptTurn[];
    best: Attempt;
    second: Attempt | null;
    validation: StatusValidation | null;
    started: number;
    source: string;
  }
) {
  const fields = {
    event: 'status_bar.update',
    sessionId: input.sessionId,
    trigger: input.trigger,
    mode: f.source,
    outcome: f.outcome === 'ok' ? 'succeeded' : f.outcome === 'partial' ? 'degraded' : 'failed',
    gapTurnCount: f.anchor.turnIndex - (f.previous?.anchorTurn ?? 0),
    inputCharCount: f.turns.reduce((n, turn) => n + turn.user.length + turn.reply.length, 0),
    attemptCount: f.second ? 2 : 1,
    // 布尔字段不在 safe-log 白名单里，用 provider（文本）区分主通道与兜底。
    provider: f.best.channel,
    expectedCount: f.validation?.expectedCount ?? 0,
    matchedCount: f.validation?.matchedCount ?? 0,
    ...problemFields(f.validation),
    durationMs: Date.now() - f.started,
  };
  if (f.outcome === 'failed') input.log.biz.warn(fields, '状态栏更新失败');
  else input.log.biz.info(fields, '状态栏已更新');
}

/** 手动或自动更新的入口；同一会话进行中的更新直接复用。 */
export function runStatusUpdate(input: UpdateInput): Promise<StatusUpdateResult> {
  const existing = inFlight.get(input.sessionId);
  if (existing) return existing;
  const job = doUpdate(input).finally(() => inFlight.delete(input.sessionId));
  inFlight.set(input.sessionId, job);
  return job;
}

/**
 * 回复 done 之后调用（不 await）：距上次记录满 STATUS_AUTO_UPDATE_EVERY_TURNS（3）轮才更新。
 * 先同步登记"进行中"，前端在 done 之后立即来读，也能看到 updating 并开始轮询。
 */
export function maybeAutoUpdateStatus(input: Omit<UpdateInput, 'trigger'>): void {
  if (inFlight.has(input.sessionId)) return;
  const job = (async (): Promise<StatusUpdateResult> => {
    const repo = statusRepo();
    const [recent, current] = await Promise.all([
      repo.readRecentTurns(input.sessionId, 1),
      repo.readCurrent(input.sessionId),
    ]);
    const latest = recent[0]?.turnIndex ?? 0;
    if (latest - (current?.anchorTurn ?? 0) < STATUS_AUTO_UPDATE_EVERY_TURNS)
      return { outcome: 'skipped' };
    return doUpdate({ ...input, trigger: 'auto' });
  })()
    .catch((err: unknown) => {
      if (
        err instanceof StatusBarError &&
        (err.code === 'STATUS_DISABLED' || err.code === 'STATUS_NOT_FOUND')
      )
        return { outcome: 'skipped' as const };
      input.log.sys.error(
        { event: 'status_bar.update.failed', err, sessionId: input.sessionId },
        '自动更新状态栏出错'
      );
      return { outcome: 'failed' as const };
    })
    .finally(() => inFlight.delete(input.sessionId));
  inFlight.set(input.sessionId, job);
}
