/**
 * 执行一个已领取的记忆任务：现算范围 → 分块压缩 → 校验 → 逐块提交版本。
 *
 * 每块单独提交：中途失败时已完成的块不丢，下次从新的覆盖终点继续。
 */
import { extractStoryMemorySections } from '@miniapp/shared';
import type {
  ClaimedStoryMemoryJob,
  StoryMemoryRepository,
} from '../../infrastructure/repositories/StoryMemoryRepository.js';
import { StoryMemoryCompressError } from '../generation/story-memory-compress.js';
import { characters, userSettings } from '../conversations/turn-repositories.js';
import { countChars, renderTurnsForCompression, type StoryTurn, turnBodyChars } from './text.js';
import { compressChunk, StoryMemoryJobError } from './compress-chunk.js';
import { notifyStoryMemory, type StoryMemoryCompressionContext } from './compression-attempt.js';
export { compressChunk, StoryMemoryJobError } from './compress-chunk.js';

/**
 * 单次任务最多读取的轮次；更长的积压由后续任务继续（finish 会重新置为 pending）。
 * worker 与聊天请求共用进程，限制单次读取量也限制了 JSON 解析对事件循环的占用。
 */
const MAX_TURNS_PER_RUN = 100;
export interface StoryMemoryJobContext extends StoryMemoryCompressionContext {
  repository: StoryMemoryRepository;
  workerId: string;
  leaseSeconds: number;
  onProgress?: (progress: StoryMemoryJobResult) => void;
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

export async function runStoryMemoryJob(
  job: ClaimedStoryMemoryJob,
  ctx: StoryMemoryJobContext
): Promise<StoryMemoryJobResult> {
  const rangeStart = job.coveredEndTurn + 1;
  // Compression may run ahead of the window: the window only advances once memory lands.
  const rangeEnd = job.targetEnd;
  const result = {
    rangeStart,
    rangeEnd: job.coveredEndTurn,
    chunks: 0,
    inputChars: 0,
    outputChars: 0,
  };
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
    const range = {
      chunk_index: index + 1,
      chunk_count: chunks.length,
      range_start: chunk[0]!.turnIndex,
      range_end: chunk.at(-1)!.turnIndex,
    };
    const compressed = await compressChunk({
      ctx: {
        ...ctx,
        onAttempt: (detail) => ctx.onAttempt?.({ ...detail, ...range }),
        onRejected: (reason, detail) => ctx.onRejected(reason, { ...detail, ...range }),
      },
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
    result.rangeEnd = coveredEnd;
    notifyStoryMemory(() => ctx.onProgress?.({ ...result }));
  }
  return { ...result, rangeEnd: coverTarget };
}

export function storyMemoryErrorCode(error: unknown): string {
  if (error instanceof StoryMemoryJobError || error instanceof StoryMemoryCompressError) {
    return error.code;
  }
  return 'internal';
}
