import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { BatchLabSampleRepository } from '../../infrastructure/repositories/BatchLabSampleRepository.js';
import { BatchLabSampleService, assemblePreviewItems } from './sample-service.js';

const validHistoryId = '11111111-1111-4111-8111-111111111111';
const duplicateHistoryId = '22222222-2222-4222-8222-222222222222';

function detail(overrides: Record<string, unknown> = {}) {
  return {
    source_history_id: validHistoryId,
    source_session_id: '33333333-3333-4333-8333-333333333333',
    source_user_id: '44444444-4444-4444-8444-444444444444',
    source_character_id: '55555555-5555-4555-8555-555555555555',
    turn_index: 2,
    revision: 0,
    user_input: 'hello',
    original_assistant_reply: 'world',
    original_model: 'openrouter/model',
    history: [{ role: 'user', content: 'previous' }],
    status: 'success',
    joined_session_id: '33333333-3333-4333-8333-333333333333',
    context_window_start_turn: 1,
    session_deleted_at: null,
    joined_character_id: '55555555-5555-4555-8555-555555555555',
    character_snapshot: { id: '55555555-5555-4555-8555-555555555555', name: '角色' },
    ...overrides,
  };
}

describe('BatchLabSampleService preview assembly', () => {
  it('deduplicates anchors and records exclusion reasons', () => {
    const result = assemblePreviewItems({
      anchors: [validHistoryId, duplicateHistoryId, duplicateHistoryId, null],
      detailById: new Map([
        [validHistoryId, detail()],
        [duplicateHistoryId, detail({ source_history_id: duplicateHistoryId, history: null })],
      ]),
      sampleLimit: 4,
      truncated: false,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.ordinal).toBe(0);
    expect(result.statistics).toMatchObject({
      requested_count: 4,
      candidate_count: 4,
      valid_count: 1,
      excluded_by_reason: {
        missing_history: 1,
        duplicate_anchor: 1,
        invalid_anchor: 1,
      },
    });
  });

  it('queries anchors first, then freezes the backend-read snapshot in one repository call', async () => {
    const anchorQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ source_history_id: validHistoryId }] })
      .mockResolvedValueOnce({ rows: [] });
    const detailQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [detail()] })
      .mockResolvedValueOnce({ rows: [] });
    const anchorClient = { query: anchorQuery, release: vi.fn() } as unknown as PoolClient;
    const detailClient = { query: detailQuery, release: vi.fn() } as unknown as PoolClient;
    const pool = {
      connect: vi.fn().mockResolvedValueOnce(anchorClient).mockResolvedValueOnce(detailClient),
    };
    const createPreview = vi.fn(async (input) => ({
      ...input,
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      created_at: '2026-09-11T06:00:00.000Z',
    }));
    const service = new BatchLabSampleService(
      { createPreview } as unknown as BatchLabSampleRepository,
      pool
    );

    const result = await service.createPreview({
      source_environment: 'test',
      template_key: null,
      template_version: null,
      sql: 'select id as source_history_id from experience.chat_history',
      parameters: {},
      sample_limit: 1,
    });

    expect(result.items[0]?.source_history_id).toBe(validHistoryId);
    expect(createPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        source_environment: 'test',
        sample_limit: 1,
        statistics: expect.objectContaining({ valid_count: 1 }),
      })
    );
    expect(String(detailQuery.mock.calls[3]?.[0])).toContain('LEFT JOIN experience.chat_sessions');
    expect(detailQuery.mock.calls[3]?.[1]).toEqual([[validHistoryId]]);
    expect(anchorClient.release).toHaveBeenCalledOnce();
    expect(detailClient.release).toHaveBeenCalledOnce();
  });
});
