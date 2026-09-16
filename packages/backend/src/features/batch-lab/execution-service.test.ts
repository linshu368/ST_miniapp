import { describe, expect, it, vi } from 'vitest';
import type { RequestLogger } from '../../lib/logger.js';
import type {
  BatchLabExecutionRepository,
  ExecutionContext,
  ExperimentAttemptRow,
} from '../../infrastructure/repositories/BatchLabExecutionRepository.js';
import type { BatchLabProcessorRepository } from '../../infrastructure/repositories/BatchLabProcessorRepository.js';
import type { GenerationHooks, GenerationRequest, GenerationResult } from '../generation/index.js';
import { BatchLabExecutionService, buildAttemptMessages } from './execution-service.js';

const attempt: ExperimentAttemptRow = {
  id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
  experiment_id: '87fce0db-a75e-45b7-87be-b8e7edc8ae8f',
  sample_set_id: '11111111-1111-4111-8111-111111111111',
  sample_ordinal: 0,
  variant_key: 'a',
  turn_index: 1,
  status: 'running',
  attempt_count: 1,
};

const context: ExecutionContext = {
  experiment: {
    id: attempt.experiment_id,
    name: 'experiment',
    sample_set_id: attempt.sample_set_id,
    source_environment: 'test',
    status: 'running',
    variants: [
      {
        key: 'a',
        name: 'A',
        model_id: 'model-a',
        openrouter_model_id: 'openrouter/a',
        tier: 'standard',
        is_free: false,
        sampling: { temperature: 0.2 },
        processor_version_id: null,
        max_turns: 1,
      },
      {
        key: 'b',
        name: 'B',
        model_id: 'model-b',
        openrouter_model_id: 'openrouter/b',
        tier: 'premium',
        is_free: false,
        sampling: {},
        processor_version_id: null,
        max_turns: 1,
      },
    ],
    total_attempts: 2,
    completed_attempts: 0,
    failed_attempts: 0,
    created_at: '2026-09-11T06:00:00.000Z',
    started_at: '2026-09-11T06:01:00.000Z',
    completed_at: null,
  },
  variant: {
    key: 'a',
    name: 'A',
    model_id: 'model-a',
    openrouter_model_id: 'openrouter/a',
    tier: 'standard',
    is_free: false,
    sampling: { temperature: 0.2 },
    processor_version_id: null,
    max_turns: 1,
  },
  sample: {
    source_user_id: '22222222-2222-4222-8222-222222222222',
    source_character_id: '33333333-3333-4333-8333-333333333333',
    user_input: 'original user input',
    original_model: 'source-model',
    history: [
      { role: 'system', content: 'system' },
      { role: 'assistant', content: 'opening' },
    ],
  },
  previousOutputs: ['previous branch reply'],
};

function fakeLogger(): RequestLogger {
  const sink = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: 'info',
    child: vi.fn(),
  };
  return Object.assign({ ...sink }, { biz: sink, sys: sink }) as unknown as RequestLogger;
}

function repository(
  overrides: Partial<BatchLabExecutionRepository> = {}
): BatchLabExecutionRepository {
  return {
    claimAttempts: vi.fn(async () => [attempt]),
    getExecutionContext: vi.fn(async () => context),
    completeAttempt: vi.fn(async () => undefined),
    failAttempt: vi.fn(async () => undefined),
    refreshExperimentCounts: vi.fn(async () => context.experiment),
    ...overrides,
  } as unknown as BatchLabExecutionRepository;
}

function generator(result: GenerationResult) {
  return {
    execute: vi.fn(
      async (_request: GenerationRequest, _hooks?: GenerationHooks, _log?: RequestLogger) => result
    ),
  };
}

describe('BatchLabExecutionService', () => {
  it('builds branch messages without changing the original user input', () => {
    expect(
      buildAttemptMessages(context.sample.history, context.previousOutputs, 'next input')
    ).toEqual([
      { role: 'system', content: 'system' },
      { role: 'assistant', content: 'opening' },
      { role: 'assistant', content: 'previous branch reply' },
      { role: 'user', content: 'next input' },
    ]);
  });

  it('executes claimed attempts with internal research policy and no display processor by default', async () => {
    const repo = repository();
    const gen = generator({
      status: 'success',
      content: 'raw output',
      generationId: 'gen-1',
      finishReason: 'stop',
      chargeId: null,
      modelId: 'model-a',
      modelOpenRouterId: 'openrouter/a',
    });
    const service = new BatchLabExecutionService(
      repo,
      {} as unknown as BatchLabProcessorRepository,
      gen,
      fakeLogger()
    );

    await expect(
      service.runWorkerOnce({ source_environment: 'test', worker_id: 'worker-1', claim_limit: 1 })
    ).resolves.toEqual({ claimed_count: 1, completed_count: 1, failed_count: 0 });

    expect(gen.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: context.sample.source_user_id,
        userInput: 'original user input',
        policy: { kind: 'internal_research' },
        stream: false,
        promptCaching: false,
      }),
      undefined,
      expect.anything()
    );
    expect(repo.completeAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: attempt.id,
        rawOutput: 'raw output',
        displayResultId: null,
      })
    );
  });

  it('marks upstream failures retryable for the first leased attempt', async () => {
    const repo = repository();
    const gen = generator({
      status: 'upstream_error',
      content: '',
      generationId: null,
      finishReason: null,
      chargeId: null,
      modelId: 'model-a',
      modelOpenRouterId: 'openrouter/a',
      upstreamStatus: 429,
    });
    const service = new BatchLabExecutionService(
      repo,
      {} as unknown as BatchLabProcessorRepository,
      gen,
      fakeLogger()
    );

    await service.runWorkerOnce({
      source_environment: 'test',
      worker_id: 'worker-1',
      claim_limit: 1,
    });

    expect(repo.failAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt,
        attemptId: attempt.id,
        errorCode: 'upstream_error',
        retryable: true,
      })
    );
  });
});
