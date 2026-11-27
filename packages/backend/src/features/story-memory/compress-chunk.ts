import { compressionAttempt, type StoryMemoryCompressionContext } from './compression-attempt.js';
import {
  renderSectionShrinkPrompt,
  replaceSection,
  sectionBody,
  sectionTarget,
  shrinkableSections,
} from './archive-sections.js';
import { countChars, memoryTargetChars, renderPromptTemplate } from './text.js';
import type { StoryMemoryCompressResult } from '../generation/story-memory-compress.js';

export class StoryMemoryJobError extends Error {
  constructor(readonly code: string) {
    super('story_memory_job_' + code);
  }
}

type ChunkResult = Pick<StoryMemoryCompressResult, 'content' | 'inputTokens' | 'outputTokens'>;

/**
 * 并入结果超过上限时才调用：按 prompt 规定的顺序逐个板块轻压，回到上限以内就停（见 archive-sections）。
 * 某个板块的精简结果不可用就保留原样、继续下一个；都压过仍超就按超长失败，等下一轮再试。
 */
async function shrinkToFit(input: {
  ctx: StoryMemoryCompressionContext;
  sections: string[];
  oldMemory: string | null;
  candidate: string;
}): Promise<ChunkResult> {
  const { ctx, sections, oldMemory } = input;
  const max = ctx.config.memory_max_chars;
  let candidate = input.candidate;
  for (const [index, heading] of shrinkableSections(sections).entries()) {
    const overflow = countChars(candidate) - max;
    if (overflow <= 0) break;
    const body = sectionBody(candidate, sections, heading);
    if (!body) continue;
    const bodyChars = countChars(body);
    const target = sectionTarget(bodyChars, overflow);
    if (target >= bodyChars) continue;
    const base = candidate;
    const { result, validation, output } = await compressionAttempt({
      ctx,
      sections,
      oldMemory,
      stage: 'section_shrink',
      attempt: index + 2,
      prompt: renderSectionShrinkPrompt({
        title: heading.replace(/^##\s*/, ''),
        body,
        targetChars: target,
      }),
      validationMaxChars: max,
      targetChars: target,
      historyChars: 0,
      recentChars: 0,
      oldMemoryChars: bodyChars,
      assemble: (raw) => replaceSection(base, sections, heading, raw),
    });
    if (validation.ok) return { ...result, content: validation.content };
    // 只有拼回去仍超长、且确实变短了才沿用这次结果继续压下一个板块；
    // 结构不可用、缩得太狠、反而变长（生产见过精简后多出 14 字）就保留原样
    if (validation.reason === 'too_long' && countChars(output) < countChars(candidate)) {
      candidate = output;
    }
  }
  throw new StoryMemoryJobError('too_long');
}

/**
 * 正常路径只有并入：不超上限就直接用（只做原有的基本校验），不做任何额外压缩。
 *   - 并入超长 → shrinkToFit；
 *   - 并入因其他原因不合格（缺板块、含思考等）→ 带原因再并入一次，这次超长同样 shrinkToFit。
 */
export async function compressChunk(input: {
  ctx: StoryMemoryCompressionContext;
  promptVars: Record<string, string>;
  sections: string[];
  oldMemory: string | null;
}): Promise<ChunkResult> {
  const { ctx, sections, oldMemory } = input;
  const max = ctx.config.memory_max_chars;
  const basePrompt = renderPromptTemplate(ctx.prompt.template, {
    ...input.promptVars,
    max_chars: String(memoryTargetChars(max)),
    old_memory: oldMemory ?? input.promptVars.old_memory ?? '（空）',
  });
  let previousReason = '';
  for (const attempt of [1, 2]) {
    const { result, validation, output } = await compressionAttempt({
      ctx,
      sections,
      oldMemory,
      stage: 'merge',
      attempt,
      prompt:
        basePrompt +
        (previousReason
          ? `\n\n【上次校验未通过】${previousReason}。保留全部分区标题，不输出思考或解释。`
          : ''),
      validationMaxChars: max,
      targetChars: memoryTargetChars(max),
      historyChars: countChars(input.promptVars.new_history ?? ''),
      recentChars: countChars(input.promptVars.recent_context ?? ''),
      oldMemoryChars: countChars(oldMemory ?? ''),
    });
    if (validation.ok) return { ...result, content: validation.content };
    if (validation.reason === 'too_long') {
      return shrinkToFit({ ctx, sections, oldMemory, candidate: output });
    }
    previousReason = validation.reason;
  }
  throw new StoryMemoryJobError(previousReason);
}
