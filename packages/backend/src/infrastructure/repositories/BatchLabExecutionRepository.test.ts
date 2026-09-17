import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toExperiment } from './BatchLabExecutionRepository.js';

const MIGRATION_PATH = new URL(
  '../../../../shared/migrations/20260916_batch_lab_execution.sql',
  import.meta.url
);
const TARGETED_WORKER_MIGRATION_PATH = new URL(
  '../../../../shared/migrations/20260917_batch_lab_targeted_worker.sql',
  import.meta.url
);
const CONTROLS_MIGRATION_PATH = new URL(
  '../../../../shared/migrations/20260917_batch_lab_experiment_controls.sql',
  import.meta.url
);

const variants = [
  {
    key: 'a',
    name: 'A',
    model_id: 'model-a',
    openrouter_model_id: 'openrouter/a',
    tier: 'standard' as const,
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
    tier: 'premium' as const,
    is_free: false,
    sampling: {},
    processor_version_id: null,
    max_turns: 1,
  },
];

describe('BatchLabExecutionRepository mappers', () => {
  it('maps experiment rows through the shared contract', () => {
    expect(
      toExperiment({
        id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
        name: 'experiment',
        source_environment: 'test',
        sample_set_id: '87fce0db-a75e-45b7-87be-b8e7edc8ae8f',
        status: 'queued',
        variants,
        total_attempts: 2,
        completed_attempts: 0,
        failed_attempts: 0,
        created_at: '2026-09-11T06:00:00.000Z',
        started_at: '2026-09-11T06:01:00.000Z',
        completed_at: null,
      })
    ).toMatchObject({ status: 'queued', variants });
  });

  it('normalizes empty metadata objects created by the additive migration', () => {
    expect(
      toExperiment({
        id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
        name: 'legacy metadata defaults',
        source_environment: 'test',
        sample_set_id: '87fce0db-a75e-45b7-87be-b8e7edc8ae8f',
        status: 'draft',
        output_preset: {},
        provider_config: {},
        variants,
        total_attempts: 0,
        completed_attempts: 0,
        failed_attempts: 0,
        created_at: '2026-09-17T06:00:00.000Z',
        started_at: null,
        completed_at: null,
      })
    ).toMatchObject({
      output_preset: { name: '', content: '', format: '' },
      provider_config: { base_url: '', key_ref: '', module_name: '' },
    });
  });
});

describe('execution migration invariants', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');

  it('claims work with row locks and SKIP LOCKED', () => {
    expect(sql).toContain('FOR UPDATE OF attempt SKIP LOCKED');
    expect(sql).toContain("status = 'running'");
    expect(sql).toContain('lease_expires_at = now() + make_interval');
  });

  it('serializes idempotent experiment creation and start', () => {
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toMatch(/idempotency_key\s+UUID NOT NULL UNIQUE/);
    expect(sql).toMatch(/start_idempotency_key\s+UUID UNIQUE/);
  });

  it('blocks later turns after a prior failed or blocked branch turn', () => {
    expect(sql).toContain("prior.status IN ('failed', 'blocked', 'unknown')");
    expect(sql).toContain('prior.turn_index < attempt.turn_index');
    expect(sql).toContain('prev.status =');
  });

  it('keeps execution inside batch_lab without wallet or source chat writes', () => {
    expect(sql).toContain('no wallet reservation and no source-domain writes');
    expect(sql).not.toContain('experience.chat_history');
    expect(sql).not.toContain('billing.user_wallets');
  });
});

describe('targeted worker migration invariants', () => {
  const sql = readFileSync(TARGETED_WORKER_MIGRATION_PATH, 'utf8');

  it('filters candidates by experiment id and retains lease-safe locking', () => {
    expect(sql).toContain('attempt.experiment_id = p_experiment_id');
    expect(sql).toContain('FOR UPDATE OF attempt SKIP LOCKED');
    expect(sql).toContain("experiment.status IN ('queued', 'running')");
  });

  it('keeps the function private to backend database roles', () => {
    expect(sql).toContain('FROM PUBLIC, anon, authenticated');
    expect(sql).toContain('TO service_role, postgres');
  });
});

describe('experiment controls migration invariants', () => {
  const sql = readFileSync(CONTROLS_MIGRATION_PATH, 'utf8');

  it('uses cooperative stop and soft delete state guards', () => {
    expect(sql).toContain("status = 'cancelled'");
    expect(sql).toContain("AND status = 'pending'");
    expect(sql).toContain("status IN ('queued', 'running')");
    expect(sql).toContain('SET deleted_at = now()');
  });

  it('keeps control functions private to backend roles', () => {
    expect(sql).toContain('FROM PUBLIC, anon, authenticated');
    expect(sql).toContain('TO service_role, postgres');
  });
});
