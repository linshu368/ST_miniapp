import {
  compressionAttempt,
  notifyStoryMemory,
  type StoryMemoryCompressionContext,
} from './compression-attempt.js';
import {
  leadSection,
  renderLeadSectionShrinkPrompt,
  replaceLeadSection,
  trimLeadSection,
} from './archive-sections.js';
import { countChars, memoryTargetChars, renderPromptTemplate } from './text.js';
import { validateStoryMemory } from './validate.js';
import type { StoryMemoryCompressResult } from '../generation/story-memory-compress.js';

/** 删条目不调模型；档案版本上记最后一次模型调用的 token 数 */
type Tokens = Pick<StoryMemoryCompressResult, 'inputTokens' | 'outputTokens'>;

export class StoryMemoryJobError extends Error {
  constructor(readonly code: string) {
    super('story_memory_job_' + code);
  }
}

/** 只精简第一个板块的目标：至少压掉超出的部分，且不多于一半 */
function leadShrinkTarget(bodyChars: number, totalChars: number, maxChars: number): number {
  const mustCut = totalChars - memoryTargetChars(maxChars);
  return Math.max(0, Math.min(Math.floor(bodyChars / 2), bodyChars - mustCut));
}

/**
 * 并入后超长：先请模型只精简第一个板块（1 次调用），仍超就删这个板块最早的条目（不调模型）。
 * 精简结果不可用时，基于并入结果直接删条目。
 */
async function fitWithinLimit(input: {
  ctx: StoryMemoryCompressionContext;
  sections: string[];
  oldMemory: string | null;
  candidate: string;
  tokens: Tokens;
}) {
  const { ctx, sections, oldMemory } = input;
  const max = ctx.config.memory_max_chars;
  let candidate = input.candidate;
  let tokens = input.tokens;
  const lead = leadSection(candidate, sections);
  const totalChars = countChars(candidate);
  const target = lead ? leadShrinkTarget(countChars(lead.body), totalChars, max) : 0;
  if (lead && target > 0) {
    const { result, validation, output } = await compressionAttempt({
      ctx,
      sections,
      oldMemory,
      stage: 'section_shrink',
      attempt: 2,
      prompt: renderLeadSectionShrinkPrompt({
        title: lead.title,
        body: lead.body,
        targetChars: target,
      }),
      validationMaxChars: max,
      targetChars: target,
      historyChars: 0,
      recentChars: 0,
      oldMemoryChars: countChars(lead.body),
      assemble: (raw) => replaceLeadSection(candidate, sections, raw),
    });
    if (validation.ok) return { ...result, content: validation.content };
    tokens = result;
    if (validation.reason === 'too_long') candidate = output;
  }
  return trimToLimit({ ctx, sections, oldMemory, candidate, tokens });
}

function trimToLimit(input: {
  ctx: StoryMemoryCompressionContext;
  sections: string[];
  oldMemory: string | null;
  candidate: string;
  tokens: Tokens;
}) {
  const { ctx, sections } = input;
  const max = ctx.config.memory_max_chars;
  const trimmed = trimLeadSection(input.candidate, sections, max);
  const validation = trimmed
    ? validateStoryMemory({
        output: trimmed.content,
        sections,
        maxChars: max,
        oldMemory: input.oldMemory,
      })
    : ({ ok: false, reason: 'too_long' } as const);
  const outputChars = countChars(trimmed?.content ?? input.candidate);
  notifyStoryMemory(() =>
    ctx.onAttempt?.({
      stage: 'trim',
      attempt: 3,
      model: ctx.model,
      prompt_version: ctx.prompt.version,
      hard_max_chars: max,
      validation_max_chars: max,
      target_chars: max,
      prompt_chars: 0,
      history_chars: 0,
      recent_chars: 0,
      old_memory_chars: countChars(input.candidate),
      duration_ms: 0,
      output_chars: outputChars,
      over_limit_chars: Math.max(0, outputChars - max),
      trimmed_line_count: trimmed?.removed ?? 0,
      outcome: validation.ok ? 'succeeded' : 'rejected',
      ...(!validation.ok ? { reason: validation.reason } : {}),
    })
  );
  if (!validation.ok) throw new StoryMemoryJobError(validation.reason);
  return {
    content: validation.content,
    inputTokens: input.tokens.inputTokens,
    outputTokens: input.tokens.outputTokens,
  };
}

/**
 * 一块最多 2 次模型调用：
 *   - 并入通过 → 结束；
 *   - 并入超长 → 只精简第一个板块 → 仍超就删最早条目；
 *   - 并入因其他原因不合格（缺板块、含思考等）→ 带原因再并入一次，这次超长就直接删条目。
 */
export async function compressChunk(input: {
  ctx: StoryMemoryCompressionContext;
  promptVars: Record<string, string>;
  sections: string[];
  oldMemory: string | null;
}) {
  const { ctx, sections, oldMemory } = input;
  const max = ctx.config.memory_max_chars;
  const basePrompt = renderPromptTemplate(ctx.prompt.template, {
    ...input.promptVars,
    max_chars: String(memoryTargetChars(max)),
    old_memory: oldMemory ?? input.promptVars.old_memory ?? '（空）',
  });
  const merge = (attempt: number, previousReason: string) =>
    compressionAttempt({
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

  const first = await merge(1, '');
  if (first.validation.ok) return { ...first.result, content: first.validation.content };
  if (first.validation.reason === 'too_long') {
    return fitWithinLimit({
      ctx,
      sections,
      oldMemory,
      candidate: first.output,
      tokens: first.result,
    });
  }
  const second = await merge(2, first.validation.reason);
  if (second.validation.ok) return { ...second.result, content: second.validation.content };
  if (second.validation.reason === 'too_long') {
    return trimToLimit({
      ctx,
      sections,
      oldMemory,
      candidate: second.output,
      tokens: second.result,
    });
  }
  throw new StoryMemoryJobError(second.validation.reason);
}
