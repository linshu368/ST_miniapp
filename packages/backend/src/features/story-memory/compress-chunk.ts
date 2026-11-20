import { compressionAttempt, type StoryMemoryCompressionContext } from './compression-attempt.js';
import { countChars, memoryTargetChars, renderPromptTemplate, renderShrinkPrompt } from './text.js';

const VALIDATION_ATTEMPTS = 3;

export class StoryMemoryJobError extends Error {
  constructor(readonly code: string) {
    super('story_memory_job_' + code);
  }
}

/** Optional pre-shrink leaves room for new facts; a failure still preserves the original archive. */
async function shrinkOldMemory(input: {
  ctx: StoryMemoryCompressionContext;
  sections: string[];
  memory: string | null;
}): Promise<string | null> {
  const { ctx, memory } = input;
  const max = ctx.config.memory_max_chars;
  if (!memory || countChars(memory) <= memoryTargetChars(max)) return memory;
  try {
    const { validation } = await compressionAttempt({
      ctx,
      sections: input.sections,
      oldMemory: null,
      stage: 'pre_shrink',
      attempt: 1,
      prompt: renderShrinkPrompt({
        memory,
        sections: input.sections,
        maxChars: max,
        targetRatio: 0.65,
      }),
      validationMaxChars: memoryTargetChars(max),
      targetChars: Math.floor(max * 0.65),
      historyChars: 0,
      recentChars: 0,
      oldMemoryChars: countChars(memory),
    });
    if (validation.ok) return validation.content;
  } catch {
    // The attempt already recorded the safe failure; the main merge can still succeed.
  }
  return memory;
}

/** Three calls at most: repair the complete candidate instead of repeatedly re-sending history. */
export async function compressChunk(input: {
  ctx: StoryMemoryCompressionContext;
  promptVars: Record<string, string>;
  sections: string[];
  oldMemory: string | null;
}) {
  const { ctx, sections } = input;
  const max = ctx.config.memory_max_chars;
  const oldMemory = await shrinkOldMemory({ ctx, sections, memory: input.oldMemory });
  const basePrompt = renderPromptTemplate(ctx.prompt.template, {
    ...input.promptVars,
    max_chars: String(memoryTargetChars(max)),
    old_memory: oldMemory ?? input.promptVars.old_memory ?? '（空）',
  });
  let candidate: string | null = null;
  let previousReason = '';
  for (let attempt = 1; attempt <= VALIDATION_ATTEMPTS; attempt += 1) {
    const shrinking = candidate !== null;
    const ratio = attempt === 2 ? 0.8 : 0.6;
    const target = shrinking ? Math.floor(max * ratio) : memoryTargetChars(max);
    const prompt = shrinking
      ? renderShrinkPrompt({ memory: candidate!, sections, maxChars: max, targetRatio: ratio })
      : basePrompt;
    const { result, validation, output } = await compressionAttempt({
      ctx,
      sections,
      oldMemory,
      stage: shrinking ? 'shrink' : 'merge',
      attempt,
      prompt:
        prompt +
        (previousReason
          ? `\n\n【上次校验未通过】${previousReason}。保留全部分区标题，不输出思考或解释。`
          : ''),
      validationMaxChars: max,
      targetChars: target,
      historyChars: shrinking ? 0 : countChars(input.promptVars.new_history ?? ''),
      recentChars: shrinking ? 0 : countChars(input.promptVars.recent_context ?? ''),
      oldMemoryChars: countChars(shrinking ? candidate! : (oldMemory ?? '')),
    });
    if (validation.ok) return { ...result, content: validation.content };
    if (attempt === VALIDATION_ATTEMPTS) throw new StoryMemoryJobError(validation.reason);
    // too_long is checked after structure/thinking: only a complete candidate may replace it.
    if (validation.reason === 'too_long') candidate = output;
    previousReason = validation.reason;
  }
  throw new StoryMemoryJobError('unreachable');
}
