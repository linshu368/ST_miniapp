import { compressionAttempt, type StoryMemoryCompressionContext } from './compression-attempt.js';
import {
  guardedShrink,
  mergeBudget,
  renderMergeBudget,
  renderOverflowRetry,
} from './archive-sections.js';
import { countChars, memoryTargetChars, renderPromptTemplate } from './text.js';
import type { StoryMemoryRejection } from './validate.js';
import type { StoryMemoryCompressResult } from '../generation/story-memory-compress.js';

export class StoryMemoryJobError extends Error {
  constructor(readonly code: string) {
    super('story_memory_job_' + code);
  }
}

type ChunkResult = Pick<StoryMemoryCompressResult, 'content' | 'inputTokens' | 'outputTokens'>;

/** 第二次并入时附上的原因：超长给出各板块字数和压缩目标；守护板块被删减点名是哪一块 */
function retryNote(input: {
  reason: StoryMemoryRejection;
  output: string;
  sections: string[];
  oldMemory: string | null;
  maxChars: number;
  targetChars: number;
}): string {
  if (input.reason === 'too_long' && input.output) {
    return renderOverflowRetry({
      sections: input.sections,
      output: input.output,
      maxChars: input.maxChars,
      targetChars: input.targetChars,
    });
  }
  const shrunk =
    input.reason === 'guarded_shrink'
      ? guardedShrink(input.oldMemory, input.output, input.sections)
      : null;
  if (shrunk) {
    const title = shrunk.heading.replace(/^##\s*/, '');
    return `【上次校验未通过】「${title}」从 ${shrunk.before} 字删到了 ${shrunk.after} 字。这一块只能新增或更新，旧条目原文保留，一条都不能删。`;
  }
  return `【上次校验未通过】${input.reason}。保留全部分区标题，不输出思考或解释。`;
}

/**
 * 一块最多两次并入（11-27 第三版）：
 *   - 每次都在 prompt 末尾附上程序算好的轮次分层和字数上限（见 archive-sections）；
 *   - 第一次不合格（超长、守护板块被删减、缺板块、含思考等）→ 带具体原因再并一次；
 *   - 两次都不合格按最后的原因失败，退避后重试。没超上限的结果直接用，程序不再额外压缩。
 */
export async function compressChunk(input: {
  ctx: StoryMemoryCompressionContext;
  promptVars: Record<string, string>;
  sections: string[];
  oldMemory: string | null;
  /** 本块最后一轮的编号，用来算近期 / 中期 / 早期的分界 */
  nowTurn: number;
}): Promise<ChunkResult> {
  const { ctx, sections, oldMemory } = input;
  const max = ctx.config.memory_max_chars;
  const target = memoryTargetChars(max);
  const historyChars = countChars(input.promptVars.new_history ?? '');
  const oldChars = countChars(oldMemory ?? '');
  const budget = mergeBudget({ oldChars, historyChars, targetChars: target });
  const basePrompt =
    renderPromptTemplate(ctx.prompt.template, {
      ...input.promptVars,
      max_chars: String(target),
      old_memory: oldMemory ?? input.promptVars.old_memory ?? '（空）',
    }) +
    '\n\n' +
    renderMergeBudget({
      sections,
      nowTurn: input.nowTurn,
      oldChars,
      budgetChars: budget,
      targetChars: target,
    });
  let note = '';
  let reason: StoryMemoryRejection | null = null;
  for (const attempt of [1, 2]) {
    const { result, validation, output } = await compressionAttempt({
      ctx,
      sections,
      oldMemory,
      stage: 'merge',
      attempt,
      prompt: note ? `${basePrompt}\n\n${note}` : basePrompt,
      validationMaxChars: max,
      targetChars: budget,
      historyChars,
      recentChars: countChars(input.promptVars.recent_context ?? ''),
      oldMemoryChars: oldChars,
    });
    if (validation.ok) return { ...result, content: validation.content };
    reason = validation.reason;
    note = retryNote({ reason, output, sections, oldMemory, maxChars: max, targetChars: target });
  }
  throw new StoryMemoryJobError(reason!);
}
