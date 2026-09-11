/**
 * @Author: whc 952987912@qq.com
 * @Date: 2026-09-11 14:57:56
 * @LastEditors: whc 952987912@qq.com
 * @LastEditTime: 2026-09-11 15:33:35
 * @Description:
 * @Copyright (c) 2026 by git config user.name, All Rights Reserved.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { DomainDb } from '../../lib/supabase.js';
import {
  BatchLabRepositoryError,
  BatchLabSampleRepository,
  repositoryError,
  toSampleSet,
  toSqlTemplate,
} from './BatchLabSampleRepository.js';

const MIGRATION_110_PATH = new URL(
  '../../../../shared/migrations/110_batch_lab_samples.sql',
  import.meta.url
);

const statistics = {
  requested_count: 1,
  candidate_count: 1,
  valid_count: 1,
  user_count: 1,
  session_count: 1,
  character_count: 1,
  excluded_by_reason: {},
  truncated: false,
  snapshot_bytes: 256,
};

const sampleSetRow = {
  id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
  name: 'sample set',
  source_environment: 'test' as const,
  source_preview_id: '87fce0db-a75e-45b7-87be-b8e7edc8ae8f',
  source_digest: `sha256:${'a'.repeat(64)}`,
  sample_count: 1,
  statistics,
  created_at: '2026-09-11T06:00:00.000Z',
};

describe('BatchLabSampleRepository mappers', () => {
  it('maps database template fields without exposing row names', () => {
    expect(
      toSqlTemplate({
        key: 'recent_turns',
        version: 1,
        name: '最近轮次',
        description: '',
        sql_body: 'select id from experience.chat_history',
        parameter_defaults: { days: 7 },
        enabled: true,
      })
    ).toMatchObject({
      sql: 'select id from experience.chat_history',
      default_parameters: { days: 7 },
    });
  });

  it('rejects an invalid persisted sample count', () => {
    expect(() =>
      toSampleSet({
        id: '35d2159d-dcea-46e9-aab2-8c68bd14e307',
        name: 'empty',
        source_environment: 'test',
        source_preview_id: '87fce0db-a75e-45b7-87be-b8e7edc8ae8f',
        source_digest: `sha256:${'a'.repeat(64)}`,
        sample_count: 0,
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
        created_at: '2026-09-11T06:00:00.000Z',
      })
    ).toThrow();
  });

  it('classifies freeze conflicts without leaking raw database messages', () => {
    const error = repositoryError({ message: 'BATCH_LAB_PREVIEW_EXPIRED details' });
    expect(error).toBeInstanceOf(BatchLabRepositoryError);
    expect(error.code).toBe('BATCH_LAB_PREVIEW_EXPIRED');
    expect(error.message).not.toContain('details');
  });
});

describe('BatchLabSampleRepository RPC boundary', () => {
  it('passes the preview snapshot and byte count to one atomic RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          id: '87fce0db-a75e-45b7-87be-b8e7edc8ae8f',
          digest: `sha256:${'a'.repeat(64)}`,
          source_environment: 'test',
          final_sql: 'select id from experience.chat_history',
          parameters: {},
          sample_limit: 1,
          statistics,
          created_at: '2026-09-11T06:00:00.000Z',
          expires_at: '2026-09-11T06:15:00.000Z',
        },
      ],
      error: null,
    });
    const repository = new BatchLabSampleRepository({ rpc } as unknown as DomainDb);
    const item = {
      ordinal: 0,
      source_history_id: '11111111-1111-4111-8111-111111111111',
      source_session_id: '22222222-2222-4222-8222-222222222222',
      source_user_id: '33333333-3333-4333-8333-333333333333',
      source_character_id: '44444444-4444-4444-8444-444444444444',
      turn_index: 1,
      revision: 0,
      user_input: 'hello',
      original_assistant_reply: 'world',
      original_model: 'model',
      history: [{ role: 'user' as const, content: 'hello' }],
      character_snapshot: {},
      dynamic_input_snapshot: {},
      restoration_strategy: 'exact_prompt_snapshot' as const,
    };

    const result = await repository.createPreview({
      digest: `sha256:${'a'.repeat(64)}`,
      source_environment: 'test',
      template_key: null,
      template_version: null,
      final_sql: 'select id from experience.chat_history',
      parameters: {},
      sample_limit: 1,
      statistics,
      items: [item],
      expires_at: '2026-09-11T06:15:00.000Z',
    });

    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith(
      'create_sample_preview',
      expect.objectContaining({ p_snapshot_bytes: 256, p_items: [item] })
    );
    expect(result.items).toEqual([item]);
  });

  it('uses the caller idempotency key for freeze and validates the returned row', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [sampleSetRow], error: null });
    const repository = new BatchLabSampleRepository({ rpc } as unknown as DomainDb);

    const result = await repository.freezeSampleSet({
      name: 'sample set',
      preview_id: sampleSetRow.source_preview_id,
      preview_digest: sampleSetRow.source_digest,
      source_environment: 'test',
      idempotency_key: '55555555-5555-4555-8555-555555555555',
    });

    expect(rpc).toHaveBeenCalledWith('freeze_sample_set', {
      p_name: 'sample set',
      p_preview_id: sampleSetRow.source_preview_id,
      p_preview_digest: sampleSetRow.source_digest,
      p_source_environment: 'test',
      p_idempotency_key: '55555555-5555-4555-8555-555555555555',
    });
    expect(result.id).toBe(sampleSetRow.id);
  });

  it('fails closed when an RPC succeeds without returning a row', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const repository = new BatchLabSampleRepository({ rpc } as unknown as DomainDb);

    await expect(
      repository.freezeSampleSet({
        name: 'sample set',
        preview_id: sampleSetRow.source_preview_id,
        preview_digest: sampleSetRow.source_digest,
        source_environment: 'test',
        idempotency_key: '55555555-5555-4555-8555-555555555555',
      })
    ).rejects.toMatchObject({ code: 'BATCH_LAB_PROTOCOL_ERROR' });
  });
});

describe('migration 110 concurrency and security invariants', () => {
  const sql = readFileSync(MIGRATION_110_PATH, 'utf8');

  it('serializes equal idempotency keys before reading or inserting a sample set', () => {
    const lock = sql.indexOf('pg_advisory_xact_lock');
    const idempotencyLookup = sql.indexOf(
      'FROM batch_lab.sample_sets WHERE idempotency_key = p_idempotency_key'
    );
    const insert = sql.indexOf('INSERT INTO batch_lab.sample_sets');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(idempotencyLookup);
    expect(idempotencyLookup).toBeLessThan(insert);
  });

  it('locks the preview and freezes snapshots in the same database function', () => {
    const freezeFunction = sql.slice(sql.indexOf('FUNCTION batch_lab.freeze_sample_set'));
    expect(freezeFunction).toContain('FOR UPDATE');
    expect(freezeFunction).toContain('INSERT INTO batch_lab.sample_snapshots');
    expect(freezeFunction).toContain('SET consumed_at = now()');
    expect(freezeFunction).toContain('SECURITY INVOKER');
  });

  it('keeps the source login disabled and deny-by-default until manual credential setup', () => {
    expect(sql).toContain('CREATE ROLE batch_lab_source_login NOLOGIN');
    expect(sql).toContain(
      'ALTER ROLE batch_lab_source_login SET default_transaction_read_only = on'
    );
    expect(sql).toContain(
      'REVOKE ALL ON ALL TABLES IN SCHEMA batch_lab FROM PUBLIC, anon, authenticated'
    );
    expect(sql).not.toMatch(/PASSWORD\s+['"]/i);
  });
});
