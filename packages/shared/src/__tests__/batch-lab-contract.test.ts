/**
 * @Author: whc 952987912@qq.com
 * @Date: 2026-09-11 14:38:37
 * @LastEditors: whc 952987912@qq.com
 * @LastEditTime: 2026-09-11 14:38:41
 * @Description:
 * @Copyright (c) 2026 by git config user.name, All Rights Reserved.
 */
import { describe, expect, it } from 'vitest';
import {
  BATCH_LAB_DEFAULT_SAMPLE_LIMIT,
  BATCH_LAB_MAX_SAMPLE_LIMIT,
  batchLabCreateSampleSetRequestSchema,
  batchLabPreviewRequestSchema,
  batchLabPreviewSchema,
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
});
