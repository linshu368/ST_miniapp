import {
  observeGenerationPreparationStages,
  type GenerationPreparationStage,
} from '../../lib/engineering-observability.js';

/** Measure wall-clock gates, including waits that never reach dispatch. */
export function createConversationPreparationTiming(startedAt: number) {
  const stages: Partial<Record<GenerationPreparationStage, number>> = {};
  let stage: GenerationPreparationStage = 'route_setup';
  let stageStartedAt = startedAt;
  let identity = { provider: 'unknown', model: 'unknown' };
  let reported = false;

  function finish(incompleteStage?: GenerationPreparationStage): void {
    if (reported) return;
    reported = true;
    const now = performance.now();
    const elapsed = now - stageStartedAt;
    const total = now - startedAt;
    stages[stage] = elapsed;
    const log =
      incompleteStage || total >= 1_000
        ? {
            ...Object.fromEntries(
              Object.entries(stages).map(([name, ms]) => [`${name}_ms`, Math.round(ms)])
            ),
            total_ms: Math.round(total),
            ...(incompleteStage
              ? { outcome: 'incomplete', stage: incompleteStage, elapsed_ms: Math.round(elapsed) }
              : {}),
          }
        : undefined;
    observeGenerationPreparationStages({
      ...identity,
      stages: incompleteStage ? undefined : stages,
      log,
    });
  }

  return {
    startedAt,
    enter(next: GenerationPreparationStage, model?: { provider: string; providerModelId: string }) {
      const now = performance.now();
      stages[stage] = now - stageStartedAt;
      stage = next;
      stageStartedAt = now;
      if (model) identity = { provider: model.provider, model: model.providerModelId };
    },
    ready() {
      finish();
    },
    incomplete() {
      finish(stage);
    },
  };
}

export type ConversationPreparationTiming = ReturnType<typeof createConversationPreparationTiming>;
