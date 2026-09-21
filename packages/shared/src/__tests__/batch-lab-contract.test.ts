/**
 * @Author: whc 952987912@qq.com
 * @Date: 2026-09-11 14:38:37
 * @LastEditors: whc 952987912@qq.com
 * @LastEditTime: 2026-09-17 18:37:59
 * @Description:
 * @Copyright (c) 2026 by git config user.name, All Rights Reserved.
 */
import { describe, expect, it } from 'vitest';
import {
  BATCH_LAB_DEFAULT_SAMPLE_LIMIT,
  BATCH_LAB_MAX_WORKER_CLAIM_LIMIT,
  batchLabCreateExperimentRequestSchema,
  batchLabDeleteExperimentRequestSchema,
  batchLabExportRowSchema,
  BATCH_LAB_MAX_SAMPLE_LIMIT,
  BATCH_LAB_JSONL_SCHEMA_VERSION,
  batchLabExperimentSummarySchema,
  batchLabReuseDisplayExperimentRequestSchema,
  batchLabCreateSampleSetRequestSchema,
  batchLabProcessorConfigSchema,
  batchLabProcessorPreviewRequestSchema,
  batchLabPreviewRequestSchema,
  batchLabPreviewSchema,
  batchLabRunExperimentWorkerRequestSchema,
  batchLabRunWorkerRequestSchema,
  batchLabStopExperimentRequestSchema,
} from '../api/batch-lab';

describe('batch lab data sample contracts', () => {
  const request = {
    source_environment: 'test' as const,
    template_key: null,
    template_version: null,
    sql: 'select id from experience.chat_history',
    parameters: {},
  };

  it('applies the preview default and rejects excessive limits', () => {
    expect(batchLabPreviewRequestSchema.parse(request).sample_limit).toBe(
      BATCH_LAB_DEFAULT_SAMPLE_LIMIT
    );
    expect(
      batchLabPreviewRequestSchema.safeParse({
        ...request,
        sample_limit: BATCH_LAB_MAX_SAMPLE_LIMIT + 1,
      }).success
    ).toBe(false);
  });

  it('requires an experiment id for targeted worker execution', () => {
    expect(
      batchLabRunExperimentWorkerRequestSchema.safeParse({
        experiment_id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
        source_environment: 'test',
        worker_id: 'batch-lab-ui',
        claim_limit: 1,
      }).success
    ).toBe(true);
    expect(
      batchLabRunExperimentWorkerRequestSchema.safeParse({
        source_environment: 'test',
        worker_id: 'batch-lab-ui',
        claim_limit: 1,
      }).success
    ).toBe(false);
  });

  it('binds stop and delete controls to one experiment and source environment', () => {
    const input = {
      experiment_id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
      source_environment: 'test' as const,
    };
    expect(batchLabStopExperimentRequestSchema.safeParse(input).success).toBe(true);
    expect(batchLabDeleteExperimentRequestSchema.safeParse(input).success).toBe(true);
    expect(
      batchLabStopExperimentRequestSchema.safeParse({ source_environment: 'test' }).success
    ).toBe(false);
  });

  it('requires template key and version to move together', () => {
    expect(
      batchLabPreviewRequestSchema.safeParse({
        ...request,
        template_key: 'recent_turns',
        sample_limit: 50,
      }).success
    ).toBe(false);
  });

  it('binds sample-set creation to one environment and preview digest', () => {
    expect(
      batchLabCreateSampleSetRequestSchema.safeParse({
        name: 'test sample set',
        preview_id: '87fce0db-a75e-45b7-87be-b8e7edc8ae8f',
        preview_digest: `sha256:${'a'.repeat(64)}`,
        source_environment: 'test',
        idempotency_key: 'd5e7e560-6f51-4be1-bcf0-745652088fa2',
      }).success
    ).toBe(true);
  });

  it('rejects unknown preview fields', () => {
    expect(
      batchLabPreviewSchema.safeParse({
        id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
        digest: `sha256:${'b'.repeat(64)}`,
        source_environment: 'test',
        final_sql: request.sql,
        parameters: {},
        sample_limit: 50,
        statistics: {
          requested_count: 50,
          candidate_count: 0,
          valid_count: 0,
          user_count: 0,
          session_count: 0,
          character_count: 0,
          excluded_by_reason: {},
          truncated: false,
          snapshot_bytes: 0,
        },
        items: [],
        created_at: '2026-09-11T06:00:00.000Z',
        expires_at: '2026-09-11T06:15:00.000Z',
        leaked_database_row: true,
      }).success
    ).toBe(false);
  });

  it('validates bounded regex processor config', () => {
    expect(
      batchLabProcessorConfigSchema.safeParse({
        protocol: 'regex_json_v1',
        rules: [{ pattern: 'hello', flags: 'gi', replacement: 'hi' }],
        timeout_ms: 250,
      }).success
    ).toBe(true);
    expect(
      batchLabProcessorConfigSchema.safeParse({
        protocol: 'regex_json_v1',
        rules: [{ pattern: 'hello', flags: 'gg', replacement: 'hi' }],
        timeout_ms: 250,
      }).success
    ).toBe(false);
  });

  it('requires processor previews to reference exactly one processor source', () => {
    expect(
      batchLabProcessorPreviewRequestSchema.safeParse({
        processor_version_id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
        input_text: 'hello',
      }).success
    ).toBe(true);
    expect(
      batchLabProcessorPreviewRequestSchema.safeParse({
        processor_version_id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
        config: { protocol: 'none_v1' },
        input_text: 'hello',
      }).success
    ).toBe(false);
  });

  it('requires experiment variants to be a unique A/B pair', () => {
    const variant = {
      key: 'a',
      name: 'A',
      model_id: 'model-a',
      openrouter_model_id: 'openrouter/a',
      tier: 'standard' as const,
      is_free: false,
      sampling: {},
      processor_version_id: null,
      max_turns: 1,
    };
    expect(
      batchLabCreateExperimentRequestSchema.safeParse({
        name: 'experiment',
        sample_set_id: '87fce0db-a75e-45b7-87be-b8e7edc8ae8f',
        source_environment: 'test',
        idempotency_key: 'd5e7e560-6f51-4be1-bcf0-745652088fa2',
        variants: [variant, { ...variant, key: 'b', name: 'B' }],
      }).success
    ).toBe(true);
    expect(
      batchLabCreateExperimentRequestSchema.safeParse({
        name: 'experiment',
        sample_set_id: '87fce0db-a75e-45b7-87be-b8e7edc8ae8f',
        source_environment: 'test',
        idempotency_key: 'd5e7e560-6f51-4be1-bcf0-745652088fa2',
        variants: [variant, variant],
      }).success
    ).toBe(false);
  });

  it('bounds worker claim size', () => {
    expect(
      batchLabRunWorkerRequestSchema.safeParse({
        source_environment: 'test',
        worker_id: 'worker-1',
        claim_limit: BATCH_LAB_MAX_WORKER_CLAIM_LIMIT + 1,
      }).success
    ).toBe(false);
  });

  it('validates reuse-display requests as zero-generation experiment inputs', () => {
    const variant = {
      key: 'a',
      name: 'A',
      model_id: 'model-a',
      openrouter_model_id: 'openrouter/a',
      tier: 'standard' as const,
      is_free: false,
      sampling: {},
      processor_version_id: null,
      max_turns: 1,
    };
    expect(
      batchLabReuseDisplayExperimentRequestSchema.safeParse({
        source_experiment_id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
        name: 'reuse display',
        source_environment: 'test',
        variants: [variant, { ...variant, key: 'b', name: 'B' }],
        idempotency_key: 'd5e7e560-6f51-4be1-bcf0-745652088fa2',
      }).success
    ).toBe(true);
  });

  it('validates JSONL export rows with frozen sample and failed attempts', () => {
    const variant = {
      key: 'a',
      name: 'A',
      model_id: 'model-a',
      openrouter_model_id: 'openrouter/a',
      tier: 'standard' as const,
      is_free: false,
      sampling: {},
      processor_version_id: null,
      max_turns: 1,
    };
    expect(
      batchLabExportRowSchema.safeParse({
        schema_version: BATCH_LAB_JSONL_SCHEMA_VERSION,
        experiment: {
          id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
          name: 'experiment',
          sample_set_id: '87fce0db-a75e-45b7-87be-b8e7edc8ae8f',
          source_environment: 'test',
          status: 'failed',
          variants: [variant, { ...variant, key: 'b', name: 'B' }],
          total_attempts: 2,
          completed_attempts: 1,
          failed_attempts: 1,
          created_at: '2026-09-11T06:00:00.000Z',
          started_at: '2026-09-11T06:01:00.000Z',
          completed_at: '2026-09-11T06:02:00.000Z',
          lineage: {
            kind: 'generation',
            source_experiment_id: null,
            generation_source_experiment_id: null,
          },
        },
        sample: {
          ordinal: 0,
          source_history_id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
          source_session_id: '87fce0db-a75e-45b7-87be-b8e7edc8ae8f',
          source_user_id: 'd5e7e560-6f51-4be1-bcf0-745652088fa2',
          source_character_id: '3f902d7f-734c-4ca7-b40f-a780d48d46e4',
          turn_index: 12,
          revision: 0,
          user_input: 'hello',
          original_assistant_reply: 'world',
          original_model: 'model-a',
          history: [{ role: 'user', content: 'hello' }],
          character_snapshot: {},
          dynamic_input_snapshot: {},
          restoration_strategy: 'exact_prompt_snapshot',
        },
        attempts: [
          {
            attempt_id: '26d2159d-dcea-46e9-aab2-8c68bd14e307',
            variant_key: 'a',
            turn_index: 1,
            status: 'failed',
            generation_id: null,
            finish_reason: null,
            raw_output: null,
            display_result_id: null,
            error_code: 'BATCH_LAB_EXPERIMENT_VALIDATION_ERROR',
            error_message: 'failed',
          },
        ],
        annotations: [],
      }).success
    ).toBe(true);
  });

  it('rejects storage-only experiment fields from public summaries', () => {
    expect(
      batchLabExperimentSummarySchema.safeParse({
        id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
        name: 'experiment',
        sample_set_id: '87fce0db-a75e-45b7-87be-b8e7edc8ae8f',
        source_environment: 'test',
        status: 'draft',
        variants: [
          {
            key: 'a',
            name: 'A',
            model_id: 'model-a',
            openrouter_model_id: 'openrouter/a',
            tier: 'standard',
            is_free: false,
            sampling: {},
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
        total_attempts: 0,
        completed_attempts: 0,
        failed_attempts: 0,
        created_at: '2026-09-11T06:00:00.000Z',
        started_at: null,
        completed_at: null,
        lease_owner: 'worker-1',
      }).success
    ).toBe(false);
  });
});
