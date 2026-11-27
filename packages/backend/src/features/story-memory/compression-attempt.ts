import type { StoryMemoryConfig } from '@miniapp/shared';
import { storyMemoryRoute } from '../generation/surplus-route.js';
import {
  compressStoryMemory,
  StoryMemoryCompressError,
  type StoryMemoryCompressDiagnostics,
} from '../generation/story-memory-compress.js';
import type { StoryMemoryPromptTemplate } from './config.js';
import { countChars } from './text.js';
import {
  stripCodeFence,
  validateStoryMemory,
  type StoryMemoryRejection,
  type StoryMemoryValidation,
} from './validate.js';

export interface StoryMemoryAttemptDetail extends StoryMemoryCompressDiagnostics {
  /** merge = 并入新章节（11-27 第三版起只有这一种；超长时带各板块目标再并一次，attempt=2） */
  stage: 'merge';
  attempt: number;
  job_attempt?: number;
  model: string;
  prompt_version: string;
  hard_max_chars: number;
  validation_max_chars: number;
  target_chars: number;
  prompt_chars: number;
  history_chars: number;
  recent_chars: number;
  old_memory_chars: number;
  duration_ms: number;
  outcome: 'succeeded' | 'rejected' | 'failed' | 'timed_out' | 'cancelled';
  over_limit_chars?: number;
  error_code?: string;
  reason?: StoryMemoryRejection;
  err?: unknown;
  chunk_index?: number;
  chunk_count?: number;
  range_start?: number;
  range_end?: number;
}

export interface StoryMemoryCompressionContext {
  config: StoryMemoryConfig;
  prompt: StoryMemoryPromptTemplate;
  model: string;
  onRejected: (reason: StoryMemoryRejection, detail: StoryMemoryAttemptDetail) => void;
  onAttempt?: (detail: StoryMemoryAttemptDetail) => void;
}

/** Telemetry failure cannot invalidate a usable archive or cause another paid model call. */
export function notifyStoryMemory(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    /* The logger owns its output health. */
  }
}

export async function compressionAttempt(input: {
  ctx: StoryMemoryCompressionContext;
  prompt: string;
  sections: string[];
  oldMemory: string | null;
  stage: StoryMemoryAttemptDetail['stage'];
  attempt: number;
  validationMaxChars: number;
  targetChars: number;
  historyChars: number;
  recentChars: number;
  oldMemoryChars: number;
}) {
  const { ctx } = input;
  const startedAt = performance.now();
  const detail = {
    stage: input.stage,
    attempt: input.attempt,
    model: ctx.model,
    prompt_version: ctx.prompt.version,
    hard_max_chars: ctx.config.memory_max_chars,
    validation_max_chars: input.validationMaxChars,
    target_chars: input.targetChars,
    prompt_chars: countChars(input.prompt),
    history_chars: input.historyChars,
    recent_chars: input.recentChars,
    old_memory_chars: input.oldMemoryChars,
  };
  let result: Awaited<ReturnType<typeof compressStoryMemory>>;
  try {
    result = await compressStoryMemory({
      model: ctx.model,
      route: storyMemoryRoute(ctx.config),
      reasoningEffort: ctx.config.reasoning_effort,
      firstOutputTimeoutMs: ctx.config.first_output_timeout_ms,
      prompt: input.prompt,
      temperature: ctx.config.temperature,
    });
  } catch (err) {
    const code = err instanceof StoryMemoryCompressError ? err.code : 'internal';
    notifyStoryMemory(() =>
      ctx.onAttempt?.({
        ...detail,
        ...(err instanceof StoryMemoryCompressError ? err.diagnostics : {}),
        ...(err instanceof StoryMemoryCompressError && err.diagnostics?.output_chars !== undefined
          ? {
              over_limit_chars: Math.max(
                0,
                err.diagnostics.output_chars - input.validationMaxChars
              ),
            }
          : {}),
        duration_ms: Math.round(performance.now() - startedAt),
        outcome:
          code === 'timeout' || code === 'first_output_timeout'
            ? 'timed_out'
            : code === 'cancelled'
              ? 'cancelled'
              : 'failed',
        error_code: code,
        err,
      })
    );
    throw err;
  }
  const validation: StoryMemoryValidation = validateStoryMemory({
    output: result.content,
    sections: input.sections,
    maxChars: input.validationMaxChars,
    oldMemory: input.oldMemory,
  });
  const output = stripCodeFence(result.content);
  const outputChars = countChars(output);
  const observation: StoryMemoryAttemptDetail = {
    ...detail,
    ...result.diagnostics,
    ...(result.inputTokens !== null ? { input_tokens: result.inputTokens } : {}),
    ...(result.outputTokens !== null ? { output_tokens: result.outputTokens } : {}),
    output_chars: outputChars,
    over_limit_chars: Math.max(0, outputChars - input.validationMaxChars),
    duration_ms: Math.round(performance.now() - startedAt),
    outcome: validation.ok ? 'succeeded' : 'rejected',
    ...(!validation.ok ? { reason: validation.reason } : {}),
  };
  notifyStoryMemory(() => ctx.onAttempt?.(observation));
  if (!validation.ok) notifyStoryMemory(() => ctx.onRejected(validation.reason, observation));
  return { result, validation, output };
}
