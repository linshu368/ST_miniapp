import { BATCH_LAB_MAX_PREVIEW_BYTES } from '@miniapp/shared';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  BatchLabSourceQueryError,
  compileBatchLabSourceSql,
  executeBatchLabSourceQuery,
} from './source-query.js';

describe('Batch Lab source SQL compiler', () => {
  it('binds named values without interpolating them', () => {
    const compiled = compileBatchLabSourceSql(
      `with selected as (
         select * from experience.chat_history where user_id = :user_id
       ) select * from selected where turn_index >= :minimum_turn`,
      { user_id: "'; delete from x; --", minimum_turn: 2 }
    );
    expect(compiled.text).toContain('user_id = $1');
    expect(compiled.text).toContain('turn_index >= $2');
    expect(compiled.text).not.toContain('delete from x');
    expect(compiled.values).toEqual(["'; delete from x; --", 2]);
  });

  it.each([
    'delete from experience.chat_history',
    'select * from experience.chat_history; select 1',
    'with changed as (update experience.chat_history set user_input = null returning *) select * from changed',
    'select * from billing.user_wallets',
    'with billing as (select * from experience.chat_history) select * from billing.user_wallets',
    'select now() from experience.chat_history',
    'select "pg_catalog"."pg_sleep"(1) from experience.chat_history',
    'select 1 into temporary unsafe_table from experience.chat_history',
    'select * from experience.chat_history where user_id in (select user_id from app_core.users)',
    'select $$unsafe$$ from experience.chat_history',
  ])('rejects unsafe SQL: %s', (sql) => {
    expect(() => compileBatchLabSourceSql(sql, {})).toThrowError(BatchLabSourceQueryError);
  });

  it('does not treat strings and comments as statements or parameters', () => {
    const compiled = compileBatchLabSourceSql(
      `select ':ignored; delete' as value from experience.chat_history
       -- :also_ignored; update
       where user_id = :user_id`,
      { user_id: 'safe' }
    );
    expect(compiled.values).toEqual(['safe']);
  });

  it('accepts grouping, casts, and references to a declared CTE', () => {
    const compiled = compileBatchLabSourceSql(
      `with selected as (
         select user_id::text as user_id from experience.chat_history where (user_id = :user_id)
       ) select * from selected`,
      { user_id: 'safe' }
    );
    expect(compiled.values).toEqual(['safe']);
    expect(compiled.text).toContain('user_id::text');
  });

  it('rejects missing and unused parameters', () => {
    const sql = 'select * from experience.chat_history where user_id = :user_id';
    expect(() => compileBatchLabSourceSql(sql, {})).toThrowError(BatchLabSourceQueryError);
    expect(() => compileBatchLabSourceSql(sql, { user_id: 'x', unused: true })).toThrowError(
      BatchLabSourceQueryError
    );
  });
});

describe('Batch Lab bounded source query', () => {
  it('maps connection failures without exposing the raw connection error', async () => {
    await expect(
      executeBatchLabSourceQuery({ text: 'select 1', values: [] }, 1, {
        connect: vi.fn().mockRejectedValue(new Error('secret endpoint')),
      })
    ).rejects.toMatchObject({
      code: 'BATCH_LAB_SOURCE_UNAVAILABLE',
      message: 'Batch Lab source query failed',
    });
  });

  it('uses an explicit read-only transaction and one extra row for truncation', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    const result = await executeBatchLabSourceQuery({ text: 'select 1 as id', values: [] }, 2, pool);

    expect(result).toMatchObject({ rows: [{ id: 1 }, { id: 2 }], truncated: true });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN READ ONLY',
      "SET LOCAL statement_timeout = '5s'",
      "SET LOCAL lock_timeout = '500ms'",
      'SELECT * FROM (select 1 as id) AS batch_lab_source_preview LIMIT 3',
      'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rolls back and maps timeout without exposing the database message', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error('secret SQL text'), { code: '57014' }))
      .mockResolvedValueOnce({ rows: [] });
    const client = { query, release: vi.fn() } as unknown as PoolClient;

    await expect(
      executeBatchLabSourceQuery(
        { text: 'select * from experience.chat_history', values: [] },
        1,
        { connect: vi.fn().mockResolvedValue(client) }
      )
    ).rejects.toMatchObject({ code: 'BATCH_LAB_TIMEOUT', message: 'Batch Lab source query timed out' });
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rolls back when the bounded rows exceed the byte budget', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ value: 'x'.repeat(BATCH_LAB_MAX_PREVIEW_BYTES) }] })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query, release: vi.fn() } as unknown as PoolClient;

    await expect(
      executeBatchLabSourceQuery(
        { text: 'select value from experience.chat_history', values: [] },
        1,
        { connect: vi.fn().mockResolvedValue(client) }
      )
    ).rejects.toMatchObject({ code: 'BATCH_LAB_CAPACITY_EXCEEDED' });
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });
});