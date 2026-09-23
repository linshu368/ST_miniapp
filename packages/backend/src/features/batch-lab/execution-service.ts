import { createHash } from 'node:crypto';
import type {
  BatchLabAnnotation,
  BatchLabCopyExperimentRequest,
  BatchLabCreateExperimentRequest,
  BatchLabDeleteExperimentRequest,
  BatchLabExperimentDetail,
  BatchLabExperimentResultDetail,
  BatchLabExperimentSummary,
  BatchLabExportRow,
  BatchLabReuseDisplayExperimentRequest,
  BatchLabRunWorkerRequest,
  BatchLabRunExperimentWorkerRequest,
  BatchLabRunWorkerResult,
  BatchLabStartExperimentRequest,
  BatchLabStopExperimentRequest,
  BatchLabUpsertAnnotationRequest,
} from '@miniapp/shared';
import { createLogger, type RequestLogger } from '../../lib/logger.js';
import {
  generationService,
  type GenerationHooks,
  type GenerationMessage,
  type GenerationRequest,
  type GenerationResult,
} from '../generation/index.js';
import {
  BatchLabExecutionRepository,
  type ExperimentAttemptRow,
} from '../../infrastructure/repositories/BatchLabExecutionRepository.js';
import { BatchLabProcessorRepository } from '../../infrastructure/repositories/BatchLabProcessorRepository.js';
import { BatchLabRepositoryError } from '../../infrastructure/repositories/BatchLabSampleRepository.js';
import { runPostprocessor } from './postprocessing-service.js';

export class BatchLabExecutionService {
  constructor(
    private readonly repository = new BatchLabExecutionRepository(),
    private readonly processorRepository = new BatchLabProcessorRepository(),
    private readonly generator: BatchLabGenerationExecutor = generationService,
    private readonly log: RequestLogger = createLogger('batch-lab-execution')
  ) {}

  createExperiment(input: BatchLabCreateExperimentRequest): Promise<BatchLabExperimentSummary> {
    return this.repository.createExperiment(input);
  }

  startExperiment(input: BatchLabStartExperimentRequest): Promise<BatchLabExperimentSummary> {
    return this.repository.startExperiment(input);
  }

  stopExperiment(input: BatchLabStopExperimentRequest): Promise<BatchLabExperimentSummary> {
    return this.repository.stopExperiment(input);
  }

  deleteExperiment(
    input: BatchLabDeleteExperimentRequest
  ): Promise<{ id: string; deleted_at: string }> {
    return this.repository.softDeleteExperiment(input);
  }

  listExperiments(): Promise<BatchLabExperimentSummary[]> {
    return this.repository.listExperiments();
  }

  getExperimentDetail(experimentId: string): Promise<BatchLabExperimentDetail> {
    return this.repository.getExperimentDetail(experimentId);
  }

  getExperimentResultDetail(
    experimentId: string,
    input: { sampleLimit?: number; sampleCursor?: string | null } = {}
  ): Promise<BatchLabExperimentResultDetail> {
    return this.repository.getExperimentResultDetail(experimentId, input);
  }

  copyExperiment(input: BatchLabCopyExperimentRequest): Promise<BatchLabExperimentSummary> {
    return this.repository.copyExperiment(input);
  }

  createReuseDisplayExperiment(
    input: BatchLabReuseDisplayExperimentRequest
  ): Promise<BatchLabExperimentSummary> {
    return this.repository.createReuseDisplayExperiment(input);
  }

  upsertAnnotation(input: BatchLabUpsertAnnotationRequest): Promise<BatchLabAnnotation> {
    return this.repository.upsertAnnotation(input);
  }

  buildExportRows(experimentId: string): Promise<BatchLabExportRow[]> {
    return this.repository.buildExportRows(experimentId);
  }

  async runWorkerOnce(input: BatchLabRunWorkerRequest): Promise<BatchLabRunWorkerResult> {
    const attempts = await this.repository.claimAttempts(input.worker_id, input.claim_limit);
    return this.runClaimedAttempts(attempts);
  }

  async runExperimentWorkerOnce(
    input: BatchLabRunExperimentWorkerRequest
  ): Promise<BatchLabRunWorkerResult> {
    const experiment = await this.repository.getExperimentDetail(input.experiment_id);
    if (experiment.source_environment !== input.source_environment) {
      throw new BatchLabRepositoryError(
        'BATCH_LAB_ENVIRONMENT_MISMATCH',
        'Batch Lab source environment mismatch'
      );
    }
    if (experiment.status !== 'queued' && experiment.status !== 'running') {
      throw new BatchLabRepositoryError(
        'BATCH_LAB_EXPERIMENT_STATE_CONFLICT',
        'Only queued or running experiments can be executed'
      );
    }
    const attempts = await this.repository.claimAttempts(
      input.worker_id,
      input.claim_limit,
      input.experiment_id
    );
    return this.runClaimedAttempts(attempts);
  }

  private async runClaimedAttempts(
    attempts: ExperimentAttemptRow[]
  ): Promise<BatchLabRunWorkerResult> {
    let completedCount = 0;
    let failedCount = 0;

    for (const attempt of attempts) {
      const result = await this.runAttempt(attempt);
      if (result === 'completed') completedCount += 1;
      else failedCount += 1;
    }

    return {
      claimed_count: attempts.length,
      completed_count: completedCount,
      failed_count: failedCount,
    };
  }

  private async runAttempt(attempt: ExperimentAttemptRow): Promise<'completed' | 'failed'> {
    try {
      const context = await this.repository.getExecutionContext(attempt);
      const messages = buildAttemptMessages(
        context.sample.history,
        context.previousOutputs,
        context.sample.user_input,
        context.variant.output_preset
      );
      const modelName =
        context.variant.provider_config?.module_name?.trim() ||
        context.variant.openrouter_model_id.trim();
      const upstreamBaseUrl = context.variant.provider_config?.base_url?.trim() || undefined;
      const batchLabModelKey = process.env.BATCH_LAB_MODEL_KEY?.trim();
      if (!batchLabModelKey) {
        throw new BatchLabRepositoryError(
          'BATCH_LAB_CONFIGURATION_ERROR',
          'Batch Lab model key is not configured'
        );
      }
      const result = await this.generator.execute(
        {
          userId: context.sample.source_user_id,
          characterId: context.sample.source_character_id,
          model: {
            modelId: modelName,
            openRouterModelId: modelName,
            tier: null,
            isFree: false,
            entitlement: { active: false, validUntil: null },
          },
          messages,
          sampling: {},
          userInput: context.sample.user_input,
          stream: false,
          promptCaching: false,
          upstream: {
            baseUrl: upstreamBaseUrl,
            apiKey: batchLabModelKey,
          },
          policy: { kind: 'internal_research' },
        },
        undefined,
        this.log
      );

      if (result.status !== 'success') {
        const upstreamStatus = result.upstreamStatus ?? null;
        await this.repository.failAttempt({
          attempt,
          attemptId: attempt.id,
          errorCode: result.status,
          errorMessage:
            result.status === 'upstream_error'
              ? upstreamStatus === null
                ? '上游生成请求失败：未收到 HTTP 状态码，请检查网络、URL 和超时日志'
                : `上游生成请求失败（HTTP ${upstreamStatus}）`
              : `generation finished with ${result.status}`,
          retryable: attempt.attempt_count < 2 && result.status === 'upstream_error',
        });
        await this.repository.refreshExperimentCounts(attempt.experiment_id);
        return 'failed';
      }

      const displayResultId = await this.createDisplayResult(
        context.variant.processor_version_id,
        attempt.id,
        result.content
      );
      await this.repository.completeAttempt({
        attemptId: attempt.id,
        generationId: result.generationId,
        finishReason: result.finishReason,
        rawOutput: result.content,
        displayResultId,
      });
      await this.repository.refreshExperimentCounts(attempt.experiment_id);
      this.log.biz.info(
        {
          event: 'batch_lab.attempt.completed',
          experimentId: attempt.experiment_id,
          attemptId: attempt.id,
          variantKey: attempt.variant_key,
          turnIndex: attempt.turn_index,
          outputChars: result.content.length,
        },
        'Batch Lab attempt completed'
      );
      return 'completed';
    } catch (err) {
      this.log.sys.error(
        {
          event: 'batch_lab.attempt.failed',
          err,
          experimentId: attempt.experiment_id,
          attemptId: attempt.id,
          variantKey: attempt.variant_key,
          turnIndex: attempt.turn_index,
        },
        'Batch Lab attempt failed'
      );
      await this.repository.failAttempt({
        attempt,
        attemptId: attempt.id,
        errorCode:
          err instanceof BatchLabRepositoryError
            ? err.code
            : 'BATCH_LAB_EXPERIMENT_VALIDATION_ERROR',
        errorMessage: err instanceof Error ? err.message : 'unknown error',
        retryable:
          attempt.attempt_count < 2 &&
          !(err instanceof BatchLabRepositoryError && err.code === 'BATCH_LAB_CONFIGURATION_ERROR'),
      });
      await this.repository.refreshExperimentCounts(attempt.experiment_id);
      return 'failed';
    }
  }

  private async createDisplayResult(
    processorVersionId: string | null,
    attemptId: string,
    rawOutput: string
  ): Promise<string | null> {
    if (processorVersionId === null) return null;
    const processor = await this.processorRepository.getProcessorVersion(processorVersionId);
    const result = await runPostprocessor(processor, rawOutput);
    const stored = await this.processorRepository.createDisplayResult({
      ...result,
      source_kind: 'experiment_attempt',
      source_id: attemptId,
      input_digest: digestText(rawOutput),
    });
    return stored.id ?? null;
  }
}

interface BatchLabGenerationExecutor {
  execute(
    request: GenerationRequest,
    hooks?: GenerationHooks,
    log?: RequestLogger
  ): Promise<GenerationResult>;
}

export function buildAttemptMessages(
  baseHistory: GenerationMessage[],
  previousOutputs: string[],
  userInput: string,
  outputPreset?: { content?: string; format?: string } | null
): GenerationMessage[] {
  const presetParts = [
    outputPreset?.content?.trim() ? `内容要求：${outputPreset.content.trim()}` : null,
    outputPreset?.format?.trim() ? `格式要求：${outputPreset.format.trim()}` : null,
  ].filter((value): value is string => value !== null);

  return [
    ...(presetParts.length > 0
      ? [
          {
            role: 'system',
            content: `请严格遵循本次 Batch Lab 输出预设。\n${presetParts.join('\n')}`,
          },
        ]
      : []),
    ...baseHistory.map((message) => ({ role: message.role, content: message.content })),
    ...previousOutputs.map((content) => ({ role: 'assistant', content })),
    { role: 'user', content: userInput },
  ];
}

function digestText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
