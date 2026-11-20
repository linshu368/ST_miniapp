/**
 * 执行一个已领取的记忆任务：现算范围 → 分块压缩 → 校验 → 逐块提交版本。
 *
 * 每块单独提交：中途失败时已完成的块不丢，下次从新的覆盖终点继续。
 */
import { extractStoryMemorySections, type StoryMemoryConfig } from '@miniapp/shared';
import type {
  ClaimedStoryMemoryJob,
  StoryMemoryRepository,
} from '../../infrastructure/repositories/StoryMemoryRepository.js';
import {
  compressStoryMemory,
  StoryMemoryCompressError,
} from '../generation/story-memory-compress.js';
import { characters, userSettings } from '../conversations/turn-repositories.js';
import type { StoryMemoryPromptTemplate } from './config.js';
import {
  countChars,
  memoryTargetChars,
  renderPromptTemplate,
  renderShrinkPrompt,
  renderTurnsForCompression,
  type StoryTurn,
  turnBodyChars,
} from './text.js';
import { stripCodeFence, validateStoryMemory, type StoryMemoryRejection } from './validate.js';

/**
 * 单次任务最多读取的轮次；更长的积压由后续任务继续（finish 会重新置为 pending）。
 * worker 与聊天请求共用进程，限制单次读取量也限制了 JSON 解析对事件循环的占用。
 */
const MAX_TURNS_PER_RUN = 100;
const VALIDATION_ATTEMPTS = 3;

export class StoryMemoryJobError extends Error {
  constructor(readonly code: string) {
    super('story_memory_job_' + code);
  }
}

export interface StoryMemoryJobContext {
  repository: StoryMemoryRepository;
  workerId: string;
  leaseSeconds: number;
  config: StoryMemoryConfig;
  prompt: StoryMemoryPromptTemplate;
  model: string;
  onRejected: (reason: StoryMemoryRejection, detail: StoryMemoryRejectionDetail) => void;
}

/** 校验未通过时的现场数据：只记字数，不记内容。没有它就看不出"超长"到底超了多少。 */
export interface StoryMemoryRejectionDetail {
  attempt: number;
  /** 本次模型输出去掉空白后的字数 */
  outputChars: number;
  maxChars: number;
  /** 本块新历史与旧记忆的字数（输入规模） */
  historyChars: number;
  oldMemoryChars: number;
  /** 本次调用是否是"精简上一次超长输出"的兜底调用 */
  shrinkPass: boolean;
}

export interface StoryMemoryJobResult {
  rangeStart: number;
  rangeEnd: number;
  chunks: number;
  inputChars: number;
  outputChars: number;
}

export function chunkTurns(turns: StoryTurn[], chunkChars: number): StoryTurn[][] {
  const chunks: StoryTurn[][] = [];
  let current: StoryTurn[] = [];
  let size = 0;
  for (const turn of turns) {
    const chars = turnBodyChars(turn);
    if (current.length > 0 && size + chars > chunkChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(turn);
    size += chars;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * 只取名字。角色卡 system prompt 与开场白始终在聊天 prompt 最前面、从不被截断，
 * 不需要压缩，也不送进压缩输入。
 */
export async function loadStoryContext(job: {
  sessionId: string;
  userId: string;
  characterId: string;
}) {
  const [card, displayName] = await Promise.all([
    characters().requireCard(job.characterId, job.userId, job.sessionId),
    userSettings().getDisplayName(job.userId),
  ]);
  return { userName: displayName, charName: card.name };
}

/**
 * 渲染 prompt → 调用压缩模型 → 校验；不合格最多再试两次，仍不合格抛出拒绝原因。
 * 第 2 次超长时把实际字数和上限告诉模型再要一次；仍超长则第 3 次不再重问全量历史，
 * 而是把上一次超长的输出本身交给模型精简：输入只有几千字，比"几万字压进上限"容易得多，
 * 避免长积压的会话每一轮都在同一处失败。精简后仍走同一套校验，截断或缺分区的结果照样拒绝。
 */
export async function compressChunk(input: {
  ctx: Pick<StoryMemoryJobContext, 'prompt' | 'model' | 'config' | 'onRejected'>;
  promptVars: Record<string, string>;
  sections: string[];
  oldMemory: string | null;
}) {
  const { ctx } = input;
  const max = ctx.config.memory_max_chars;
  const target = memoryTargetChars(max);
  // 旧档案已经超过目标线时，先单独精简，再并入新剧情；否则一开始就没有空间，必然超长。
  const oldMemory = await shrinkOldMemory({
    ctx,
    sections: input.sections,
    memory: input.oldMemory,
  });
  const basePrompt = renderPromptTemplate(ctx.prompt.template, {
    ...input.promptVars,
    max_chars: String(target),
    ...(oldMemory ? { old_memory: oldMemory } : {}),
  });
  const historyChars = countChars(input.promptVars.new_history ?? '');
  const oldMemoryChars = oldMemory ? countChars(oldMemory) : 0;
  let prompt = basePrompt;
  let shrinkPass = false;
  for (let attempt = 1; attempt <= VALIDATION_ATTEMPTS; attempt += 1) {
    const result = await compressStoryMemory({
      model: ctx.model,
      preferredProviders: ctx.config.preferred_providers,
      prompt,
      temperature: ctx.config.temperature,
    });
    const validation = validateStoryMemory({
      output: result.content,
      sections: input.sections,
      maxChars: max,
      oldMemory,
    });
    if (validation.ok) return { ...result, content: validation.content };
    const output = stripCodeFence(result.content);
    const outputChars = countChars(output);
    ctx.onRejected(validation.reason, {
      attempt,
      outputChars,
      maxChars: max,
      historyChars,
      oldMemoryChars,
      shrinkPass,
    });
    if (attempt === VALIDATION_ATTEMPTS) throw new StoryMemoryJobError(validation.reason);
    shrinkPass = false;
    if (validation.reason === 'too_long') {
      if (attempt === VALIDATION_ATTEMPTS - 1) {
        prompt = renderShrinkPrompt({ memory: output, sections: input.sections, maxChars: max });
        shrinkPass = true;
      } else {
        prompt = `${basePrompt}\n\n【上一次输出超长】上一次写了 ${outputChars} 字，超过上限 ${max} 字。保留全部分区标题和关键事实，合并相近内容、精简措辞，整体控制在 ${target} 字以内。`;
      }
    } else prompt = basePrompt;
  }
  throw new StoryMemoryJobError('unreachable');
}

/** 精简后的目标占上限的比例：低于模型给新档案的目标线，并入新剧情前留出约 30% 空间。 */
const PRE_SHRINK_RATIO = 0.65;

/**
 * 旧档案超过目标线时先精简。尽力而为：模型出错或结果不合格都回落到原档案，
 * 由后面的并入流程（带反馈重试、精简兜底）继续处理，不让这一步成为新的失败点。
 */
async function shrinkOldMemory(input: {
  ctx: Pick<StoryMemoryJobContext, 'model' | 'config' | 'onRejected'>;
  sections: string[];
  memory: string | null;
}): Promise<string | null> {
  const { ctx, memory } = input;
  const max = ctx.config.memory_max_chars;
  if (!memory || countChars(memory) <= memoryTargetChars(max)) return memory;
  try {
    const result = await compressStoryMemory({
      model: ctx.model,
      preferredProviders: ctx.config.preferred_providers,
      prompt: renderShrinkPrompt({
        memory,
        sections: input.sections,
        maxChars: max,
        targetRatio: PRE_SHRINK_RATIO,
      }),
      temperature: ctx.config.temperature,
    });
    const validation = validateStoryMemory({
      output: result.content,
      sections: input.sections,
      maxChars: memoryTargetChars(max),
      oldMemory: null,
    });
    if (validation.ok) return validation.content;
    ctx.onRejected(validation.reason, {
      attempt: 0,
      outputChars: countChars(stripCodeFence(result.content)),
      maxChars: max,
      historyChars: 0,
      oldMemoryChars: countChars(memory),
      shrinkPass: true,
    });
  } catch {
    // 下面的并入流程会自己遇到同样的模型错误并按原有路径处理。
  }
  return memory;
}

export async function runStoryMemoryJob(
  job: ClaimedStoryMemoryJob,
  ctx: StoryMemoryJobContext
): Promise<StoryMemoryJobResult> {
  const rangeStart = job.coveredEndTurn + 1;
  // Compression may run ahead of the window: the window only advances once memory lands.
  const rangeEnd = job.targetEnd;
  const result = { rangeStart, rangeEnd, chunks: 0, inputChars: 0, outputChars: 0 };
  if (rangeEnd < rangeStart) return result;

  const [turns, recent, story] = await Promise.all([
    ctx.repository.readTurns({
      sessionId: job.sessionId,
      fromTurn: rangeStart,
      toTurn: rangeEnd,
      limit: MAX_TURNS_PER_RUN,
    }),
    ctx.repository.readRecentTurns({
      sessionId: job.sessionId,
      fromTurn: rangeEnd + 1,
      limit: ctx.config.recent_context_turns,
    }),
    loadStoryContext(job),
  ]);
  if (turns.length === 0) throw new StoryMemoryJobError('empty_range');
  // A short read covered the whole range, including turns with no stored row.
  const coverTarget = turns.length < MAX_TURNS_PER_RUN ? rangeEnd : turns.at(-1)!.turnIndex;

  const sections = extractStoryMemorySections(ctx.prompt.template);
  const recentText = renderTurnsForCompression(recent, story.userName) || '（无）';
  let memory = job.memoryContent;
  let covered = job.coveredEndTurn;
  const chunks = chunkTurns(turns, ctx.config.chunk_chars);

  for (const [index, chunk] of chunks.entries()) {
    const newHistory = renderTurnsForCompression(chunk, story.userName);
    const compressed = await compressChunk({
      ctx,
      sections,
      oldMemory: memory,
      promptVars: {
        user_name: story.userName,
        char_name: story.charName,
        old_memory: memory ?? '（空）',
        new_history: newHistory,
        recent_context: recentText,
      },
    });
    const coveredEnd = index === chunks.length - 1 ? coverTarget : chunk.at(-1)!.turnIndex;
    await ctx.repository.commitVersion({
      sessionId: job.sessionId,
      workerId: ctx.workerId,
      expectedCoveredEnd: covered,
      coveredEnd,
      content: compressed.content,
      promptVersion: ctx.prompt.version,
      model: ctx.model,
      inputTokens: compressed.inputTokens,
      outputTokens: compressed.outputTokens,
      leaseSeconds: ctx.leaseSeconds,
    });
    memory = compressed.content;
    covered = coveredEnd;
    result.chunks += 1;
    result.inputChars += countChars(newHistory);
    result.outputChars = countChars(compressed.content);
  }
  return { ...result, rangeEnd: coverTarget };
}

export function storyMemoryErrorCode(error: unknown): string {
  if (error instanceof StoryMemoryJobError || error instanceof StoryMemoryCompressError) {
    return error.code;
  }
  return 'internal';
}
