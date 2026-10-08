import { describe, expect, it } from 'vitest';
import type { DomainDb } from '../../lib/supabase.js';
import { TextPostprocessRepository } from './repository.js';

const SOURCE = {
  schema_version: 1,
  policy_version: 1,
  rules: [
    {
      id: 'dialogue',
      name: '对白',
      description: '',
      enabled: true,
      pattern: 'hello',
      flags: 'g',
      replacement: '<p>hello</p>',
      css: '',
      notes: '',
    },
  ],
};

const ARTIFACT = {
  schema_version: 1 as const,
  policy_version: 1 as const,
  rules: [
    {
      id: 'dialogue',
      enabled: true,
      pattern: 'hello',
      flags: 'g',
      groups: { count: 0, names: [], name_by_index: [] },
      placement: 'block' as const,
      tree: [
        {
          type: 'element' as const,
          tag: 'p' as const,
          attributes: [],
          action: null,
          children: [{ type: 'text' as const, text: 'hello' }],
        },
      ],
      css: [],
    },
  ],
};

function snapshotDb(rows: unknown[]) {
  let reads = 0;
  const filters: unknown[][] = [];
  const query = {
    select() {
      return query;
    },
    in(_column: string, values: readonly number[]) {
      filters.push([...values]);
      return query;
    },
    eq() {
      return query;
    },
    order() {
      return query;
    },
    limit() {
      return query;
    },
    lt() {
      return query;
    },
    maybeSingle() {
      return Promise.resolve({ data: null, error: null });
    },
    then(
      resolve: (value: { data: unknown; error: null }) => unknown,
      reject?: (reason: unknown) => unknown
    ) {
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    },
  };
  const db = {
    from() {
      reads += 1;
      return query;
    },
    rpc() {
      throw new Error('snapshot read must not call an admin RPC');
    },
  };
  return {
    reads: () => reads,
    filters,
    db: db as unknown as DomainDb,
  };
}

describe('TextPostprocessRepository.readSnapshots', () => {
  it('loads the requested versions in one query and reports the rest unavailable', async () => {
    const fake = snapshotDb([
      {
        version: 2,
        schema_version: 1,
        policy_version: 1,
        source: SOURCE,
        artifact: ARTIFACT,
        published_at: '2026-09-28T00:00:00.000Z',
      },
      {
        version: 3,
        schema_version: 2,
        policy_version: 1,
        source: SOURCE,
        artifact: ARTIFACT,
        published_at: '2026-09-28T00:00:00.000Z',
      },
    ]);
    const repository = new TextPostprocessRepository(fake.db, fake.db, 'test');
    const result = await repository.readSnapshots([2, 3, 9]);
    expect(fake.reads()).toBe(1);
    expect(fake.filters).toEqual([[2, 3, 9]]);
    expect(result.found.map((item) => item.version)).toEqual([2]);
    expect(result.unavailable_versions).toEqual([3, 9]);
    expect(JSON.stringify(result)).not.toContain('actor');
    expect(result.found[0]).not.toHaveProperty('source');
    expect(result.found[0]).not.toHaveProperty('schema_version');
  });

  it('isolates corrupt/source-only/unsupported versions and never fills missing ones', async () => {
    const artifact = ARTIFACT;
    const row = {
      schema_version: 1,
      policy_version: 1,
      source: SOURCE,
      published_at: '2026-09-28T00:00:00.000Z',
    };
    const fake = snapshotDb([
      { ...row, version: 1, artifact },
      { ...row, version: 2 },
      { ...row, version: 3, artifact: {} },
      { ...row, version: 4, artifact: { ...artifact, policy_version: 2 } },
      { ...row, version: 99, artifact },
    ]);
    const repository = new TextPostprocessRepository(fake.db, fake.db, 'test');
    expect(await repository.readSnapshots([1, 2, 3, 4, 5])).toMatchObject({
      found: [{ version: 1, artifact }],
      unavailable_versions: [2, 3, 4, 5],
    });
    expect(fake.reads()).toBe(1);
  });

  it('rejects a batch outside the shared limit before querying', async () => {
    const fake = snapshotDb([]);
    const repository = new TextPostprocessRepository(fake.db, fake.db, 'test');
    await expect(
      repository.readSnapshots(Array.from({ length: 21 }, (_, index) => index + 1))
    ).rejects.toThrow(/shared contract/);
    expect(fake.reads()).toBe(0);
  });
});
