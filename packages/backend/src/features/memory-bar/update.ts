/**
 * 一次记忆检查：读上一份记忆 → 算这次要看的轮次和整理任务 → 主通道 → 不合格/失败转兜底（附问题清单）
 * → 有变化才落库 → 记日志。
 *
 * 记忆栏是剧情记录（shared memory-bar）：按剧情记，没进展就不动；「记到哪了」不挪，下次接着从同一处看。
 * 节奏：回复 done 之后，距上次记下东西满 3 轮的整数倍就检查一次——没进展时起点不挪，所以每 3 轮看一次，
 * 不用另存检查点（重启、多实例、重新生成都不影响），漏掉一次就等下一个 3 轮。
 * 同一会话同时只跑一次（进程内去重）：手动更新撞上进行中的自动检查，直接等它的结果。
 * 失败只记日志：不影响回复，也不影响状态更新。
 */
import {
  EMPTY_MEMORY_BAR,
  MEMORY_BAR_PROMPT_WINDOW,
  STATUS_AUTO_UPDATE_EVERY_TURNS,
  applyMemoryBarOutput,
  buildMemoryBarPromptMessages,
  memoryBarChars,
  planMemoryBarUpdate,
  splitEditableReply,
  type MemoryBarApplyResult,
  type MemoryBarLegacy,
  type MemoryBarPromptTurn,
  type MemoryBarState,
  type MemoryBarTasks,
  type MemoryRefreshOutcome,
} from '@miniapp/shared';
import {
  MemoryBarRepository,
  type MemoryPathTurn,
} from '../../infrastructure/repositories/MemoryBarRepository.js';
import type { RequestLogger } from '../../platform/observability/logger.js';
import {
  callStatusModel,
  StatusModelError,
  type StatusModelChannel,
} from '../generation/status-bar-model.js';
import { statusRepo } from '../status-bar/template.js';
import { fetchMemoryBarPrompt, type MemoryBarPrompt } from './config.js';

export interface MemoryCheckResult {
  outcome: MemoryRefreshOutcome;
}

interface CheckInput {
  userId: string;
  sessionId: string;
  trigger: 'auto' | 'manual';
  log: RequestLogger;
}

let repoInstance: MemoryBarRepository | null = null;
export const memoryRepo = () => (repoInstance ??= new MemoryBarRepository());

const inFlight = new Map<string, Promise<MemoryCheckResult>>();
export const isMemoryChecking = (sessionId: string) => inFlight.has(sessionId);

/** 该不该在这一轮自动检查：距上次记下东西满 3 轮的整数倍。 */
export function isMemoryCheckDue(latestTurn: number, coveredTurn: number): boolean {
  const gap = latestTurn - coveredTurn;
  return gap >= STATUS_AUTO_UPDATE_EVERY_TURNS && gap % STATUS_AUTO_UPDATE_EVERY_TURNS === 0;
}

const LEGACY_BLOCK = /\[memory\]([\s\S]*?)(?:\[\/memory\]|$)/gi;

/** 旧回复里最后一个记忆区的原文（含 HTML 面板，交给模型只取内容）。 */
export function legacyMemoryText(reply: string): string {
  const blocks = [...reply.matchAll(LEGACY_BLOCK)];
  return blocks[blocks.length - 1]?.[1]?.trim() ?? '';
}

async function readLegacy(sessionId: string): Promise<MemoryBarLegacy | null> {
  const turn = await memoryRepo().readLatestLegacyMemoryTurn(sessionId);
  const text = turn?.assistantReply ? legacyMemoryText(turn.assistantReply) : '';
  return turn && text ? { text, turn: turn.turnIndex } : null;
}

const toPromptTurns = (turns: MemoryPathTurn[]): MemoryBarPromptTurn[] =>
  turns.map((turn) => ({
    index: turn.turnIndex,
    user: turn.userInput,
    // 旧消息里可能还带着选项/状态/记忆尾巴，只喂正文。
    reply: splitEditableReply(turn.assistantReply ?? '').body,
  }));

interface Attempt {
  channel: StatusModelChannel;
  /** 实际调用的模型（运营平台可换）；调用失败时为 null */
  model: string | null;
  result: MemoryBarApplyResult | null;
  error: StatusModelError | null;
}

async function attempt(
  channel: StatusModelChannel,
  build: (issues?: string[]) => { system: string; user: string },
  apply: (output: string) => MemoryBarApplyResult,
  issues?: string[]
): Promise<Attempt> {
  try {
    const response = await callStatusModel(channel, build(issues));
    return { channel, model: response.model, result: apply(response.content), error: null };
  } catch (error) {
    if (error instanceof StatusModelError) return { channel, model: null, result: null, error };
    throw error;
  }
}

interface Prepared {
  characterId: string;
  current: { id: string; state: MemoryBarState } | null;
  anchor: MemoryPathTurn;
  tasks: MemoryBarTasks;
}

/** 读上一份记忆、最新一轮、（老会话）旧记忆区，算出本次任务；不需要检查返回 null。 */
async function prepare(input: CheckInput): Promise<Prepared | null> {
  const session = await statusRepo().readSession(input.sessionId, input.userId);
  if (!session) return null;
  if (!(await memoryRepo().readShowMemory(input.userId))) return null;
  const [current, recent] = await Promise.all([
    memoryRepo().readCurrent(input.sessionId),
    statusRepo().readRecentTurns(input.sessionId, 1),
  ]);
  const anchor = recent[recent.length - 1];
  if (!anchor) return null;
  const state = current?.state ?? null;
  const legacy = current ? null : await readLegacy(input.sessionId);
  const tasks = planMemoryBarUpdate(state ?? EMPTY_MEMORY_BAR, anchor.turnIndex, legacy);
  if (!tasks) return null;
  return {
    characterId: session.characterId,
    // 库里的快照认不出时当作没有记忆，但写回时仍要比对那一条
    current: current ? { id: current.id, state: state ?? EMPTY_MEMORY_BAR } : null,
    anchor,
    tasks,
  };
}

async function doCheck(input: CheckInput): Promise<MemoryCheckResult> {
  const started = Date.now();
  const prepared = await prepare(input);
  if (!prepared) return { outcome: 'skipped' };
  const { tasks, anchor } = prepared;
  const state = prepared.current?.state ?? EMPTY_MEMORY_BAR;
  const w = MEMORY_BAR_PROMPT_WINDOW;
  const [prompt, turns, runtime, request] = await Promise.all([
    fetchMemoryBarPrompt(),
    // 多取一轮：超出 maxTurns 时提示词里会注明中间省略了一段
    memoryRepo().readTurns(
      input.sessionId,
      tasks.fromTurn - w.contextTurns,
      tasks.toTurn,
      w.maxTurns + w.contextTurns + 1
    ),
    statusRepo().readCharacterRuntime(prepared.characterId, input.userId, input.sessionId),
    memoryRepo().readRequest(input.userId, prepared.characterId),
  ]);
  if (!prompt) {
    // 运营平台没有可用的记忆栏 prompt：不检查（代码里不放兜底文本），等运营补上
    input.log.sys.error(
      {
        event: 'memory_bar.prompt.unavailable',
        sessionId: input.sessionId,
        trigger: input.trigger,
      },
      '运营平台没有可用的记忆栏 prompt，跳过检查'
    );
    return { outcome: 'failed' };
  }
  const promptTurns = toPromptTurns(turns);
  const build = (issues?: string[]) =>
    buildMemoryBarPromptMessages({
      systemPrompt: prompt.text,
      // 只给角色名字：不喂正文模型的 system prompt（卡设定、人设、补充设定）。
      character: { name: runtime.name },
      state,
      tasks,
      turns: promptTurns,
      playerRequest: request,
      retryIssues: issues,
    });
  const apply = (output: string) => applyMemoryBarOutput(state, tasks, output);
  const first = await attempt('primary', build, apply);
  if (first.error)
    input.log.sys.warn(
      {
        event: 'memory_bar.primary.failed',
        err: first.error,
        sessionId: input.sessionId,
        trigger: input.trigger,
        durationMs: Date.now() - started,
      },
      '记忆栏主通道失败，转兜底'
    );
  const firstIssues = first.result && !first.result.ok ? first.result.issues : undefined;
  const second = first.result?.ok ? null : await attempt('fallback', build, apply, firstIssues);
  const best = second?.result?.ok ? second : first.result?.ok ? first : (second ?? first);
  const outcome = await settle(input, prepared, best, prompt);
  logCheck(input, {
    ...outcome,
    best,
    second,
    tasks,
    started,
    inputCharCount: promptTurns.reduce((n, t) => n + t.user.length + t.reply.length, 0),
    gapTurnCount: anchor.turnIndex - (prepared.current?.state.covered_turn ?? 0),
    hasRequest: Boolean(request),
    promptVersion: prompt.version,
  });
  return { outcome: outcome.outcome };
}

interface Settled {
  outcome: MemoryRefreshOutcome;
  /** 日志用：记下了 / 并了旧记忆区 / 没进展 / 冲突放弃 / 输出不合格 / 模型错误码 */
  reason: string;
  state: MemoryBarState | null;
}

/** 有变化才落库；读到的那条已不是最新（别的检查先写了）就放弃本次。 */
async function settle(
  input: CheckInput,
  prepared: Prepared,
  best: Attempt,
  prompt: MemoryBarPrompt
): Promise<Settled> {
  const result = best.result;
  if (!result) return { outcome: 'failed', reason: best.error?.code ?? 'error', state: null };
  if (!result.ok) return { outcome: 'failed', reason: 'invalid', state: null };
  if (!result.changed) return { outcome: 'no_progress', reason: 'no_progress', state: null };
  const id = await memoryRepo().record({
    sessionId: input.sessionId,
    userId: input.userId,
    anchor: { historyId: prepared.anchor.historyId, turnIndex: prepared.anchor.turnIndex },
    state: result.state,
    chars: memoryBarChars(result.state),
    trigger: input.trigger,
    promptVersion: prompt.version,
    expectedPreviousId: prepared.current?.id ?? null,
  });
  if (!id) return { outcome: 'skipped', reason: 'conflict', state: null };
  // 只并了旧记忆区（没有新进展）也算记下了：面板上多了前情概要
  return {
    outcome: 'recorded',
    reason: result.recorded ? 'recorded' : 'legacy',
    state: result.state,
  };
}

function logCheck(
  input: CheckInput,
  f: Settled & {
    best: Attempt;
    second: Attempt | null;
    tasks: MemoryBarTasks;
    started: number;
    inputCharCount: number;
    gapTurnCount: number;
    hasRequest: boolean;
    promptVersion: number;
  }
) {
  const result = f.best.result;
  const fields = {
    event: 'memory_bar.update',
    sessionId: input.sessionId,
    trigger: input.trigger,
    outcome: f.outcome === 'recorded' ? 'succeeded' : f.outcome === 'failed' ? 'failed' : 'skipped',
    // kind 已被 biz/sys 日志分类占用，这里用 reason
    reason: f.reason,
    // 布尔字段不在 safe-log 白名单里，用 provider（文本）区分主通道与兜底。
    provider: f.best.channel,
    ...(f.best.model ? { model: f.best.model } : {}),
    attemptCount: f.second ? 2 : 1,
    gapTurnCount: f.gapTurnCount,
    inputCharCount: f.inputCharCount,
    requestCount: f.hasRequest ? 1 : 0,
    compressCount: f.tasks.compress.length,
    foldCount: f.tasks.fold ? 1 : 0,
    issueCount: result && !result.ok ? result.issues.length : 0,
    newMilestoneCount: result?.ok ? result.newMilestones : 0,
    recordCharCount: f.state?.records.at(-1)?.text.length ?? 0,
    memoryCharCount: f.state ? memoryBarChars(f.state) : 0,
    prompt_version: `v${f.promptVersion}`,
    durationMs: Date.now() - f.started,
  };
  if (f.outcome === 'failed') input.log.biz.warn(fields, '记忆栏检查失败');
  else input.log.biz.info(fields, '记忆栏已检查');
}

/** 手动或自动检查的入口；同一会话进行中的检查直接复用。 */
export function runMemoryCheck(input: CheckInput): Promise<MemoryCheckResult> {
  const existing = inFlight.get(input.sessionId);
  if (existing) return existing;
  const job = doCheck(input).finally(() => inFlight.delete(input.sessionId));
  inFlight.set(input.sessionId, job);
  return job;
}

/**
 * 回复 done 之后调用（不 await）：这一轮正好该检查才检查。
 * 先同步登记"进行中"，前端在 done 之后立即来读，也能看到 updating 并开始轮询。
 */
export function maybeAutoCheckMemory(
  input: Omit<CheckInput, 'trigger'> & { latestTurn: number }
): void {
  if (inFlight.has(input.sessionId)) return;
  const job = (async (): Promise<MemoryCheckResult> => {
    const current = await memoryRepo().readCurrent(input.sessionId);
    if (!isMemoryCheckDue(input.latestTurn, current?.state?.covered_turn ?? 0))
      return { outcome: 'skipped' };
    return doCheck({ ...input, trigger: 'auto' });
  })()
    .catch((err: unknown) => {
      input.log.sys.error(
        { event: 'memory_bar.update.failed', err, sessionId: input.sessionId, trigger: 'auto' },
        '自动检查记忆栏出错'
      );
      return { outcome: 'failed' as const };
    })
    .finally(() => inFlight.delete(input.sessionId));
  inFlight.set(input.sessionId, job);
}
