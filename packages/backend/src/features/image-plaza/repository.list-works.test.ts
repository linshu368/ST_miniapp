import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mapConversationRow } from './repository-model.js';

import {
  cursorFilter,
  decodeFeedCursor,
  encodeFeedCursor,
  feedFilter,
  type FeedCursor,
} from './feed-cursor.js';

it('preserves the source work for default-cover consumers and keeps legacy rows nullable', () => {
  const row = {
    id: 'conversation',
    user_id: 'owner',
    title: 'fixture',
    snapshot: null,
    created_at: '2026-11-18T00:00:00Z',
    updated_at: '2026-11-18T00:00:00Z',
  };
  expect(mapConversationRow(row, []).source_work_id).toBeNull();
  expect(mapConversationRow({ ...row, source_work_id: 'source-work' }, []).source_work_id).toBe(
    'source-work'
  );
});

type Call = { method: string; args: unknown[] };

const state = vi.hoisted(() => ({
  calls: [] as Call[],
  responses: [] as unknown[][],
  rpcResponses: [] as unknown[],
}));

function createThenableBuilder(data: unknown = []) {
  const builder: Record<string, unknown> = {};
  const track =
    (method: string) =>
    (...args: unknown[]) => {
      state.calls.push({ method, args });
      return builder;
    };
  for (const method of [
    'select',
    'is',
    'order',
    'limit',
    'or',
    'filter',
    'contains',
    'overlaps',
    'eq',
    'in',
    'gt',
    'not',
    'abortSignal',
  ] as const) {
    builder[method] = track(method);
  }
  // Supabase query builders are thenable; empty page skips hydrate.
  builder.then = (
    onFulfilled?: (value: { data: unknown; error: null }) => unknown,
    onRejected?: (reason: unknown) => unknown
  ) => Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
  return builder;
}

vi.mock('../../lib/supabase.js', () => {
  const getDomainDb = (schema: string) => {
    if (schema === 'media_plaza') {
      return {
        rpc: (name: string, args: unknown) => {
          state.calls.push({ method: 'rpc', args: [name, args] });
          return createThenableBuilder(
            state.rpcResponses.shift() ?? {
              ranking_revision: '00000000-0000-0000-0000-000000000000',
              items: [],
            }
          );
        },
        from: (table: string) => {
          state.calls.push({ method: 'from', args: [table] });
          return createThenableBuilder(state.responses.shift() ?? []);
        },
      };
    }
    return {
      from: () => createThenableBuilder(),
      rpc: vi.fn(),
    };
  };
  return { getDomainDb };
});

vi.mock('./storage.js', () => ({
  deletePlazaImage: vi.fn(),
  downloadPlazaImage: vi.fn(),
  signPlazaImagePath: vi.fn(async () => 'https://example.com/image.png'),
  signSharedWorkImagePath: vi.fn(async () => 'https://example.com/image.png'),
  uploadPlazaImage: vi.fn(),
}));

const { ImagePlazaRepository } = await import('./repository.js');

describe('ImagePlazaRepository.listWorks tag label filter', () => {
  beforeEach(() => {
    state.calls = [];
  });

  it('filters prompt_zh with escaped ILIKE pattern and does not use works tags', async () => {
    const repository = new ImagePlazaRepository();
    await repository.listWorks({
      userId: 'user-1',
      tagLabels: ['人像_50%'],
      limit: 20,
    });

    expect(state.calls.some((call) => call.method === 'contains')).toBe(false);
    expect(state.calls.some((call) => call.method === 'overlaps')).toBe(false);
    const tagCall = state.calls.find(
      (call) => call.method === 'or' && String(call.args[0]).includes('人像')
    );
    expect(tagCall?.args).toEqual(['snapshot->>prompt_zh.ilike."%人像\\\\_50\\\\%%"']);
  });

  it('does not apply tag filter when tag labels are omitted (全部)', async () => {
    const repository = new ImagePlazaRepository();
    await repository.listWorks({ userId: 'user-1', limit: 20 });

    expect(state.calls.some((call) => call.method === 'contains')).toBe(false);
    expect(state.calls.some((call) => call.method === 'overlaps')).toBe(false);
  });

  it('ANDs search or-clause with tag label filter', async () => {
    const repository = new ImagePlazaRepository();
    await repository.listWorks({
      userId: 'user-1',
      search: '猫',
      tagLabels: ['动漫'],
      limit: 20,
    });

    const orCalls = state.calls.filter((call) => call.method === 'or');
    expect(String(orCalls[0]?.args[0])).toContain('snapshot->>prompt.ilike.');
    expect(String(orCalls[0]?.args[0])).toContain('snapshot->>prompt_zh.ilike.');
    expect(String(orCalls[1]?.args[0])).toContain('snapshot->>prompt_zh.ilike."%动漫%"');
  });

  it('ORs prompt_zh labels for multi-select tags and filters media', async () => {
    const repository = new ImagePlazaRepository();
    await repository.listWorks({
      userId: 'user-1',
      tagLabels: ['肖像', '电影感'],
      media: 'video',
      sort: 'latest',
      limit: 20,
    });
    expect(state.calls.some((call) => call.method === 'overlaps')).toBe(false);
    const tagCall = state.calls.find(
      (call) => call.method === 'or' && String(call.args[0]).includes('肖像')
    );
    expect(String(tagCall?.args[0])).toContain('snapshot->>prompt_zh.ilike."%肖像%"');
    expect(String(tagCall?.args[0])).toContain('snapshot->>prompt_zh.ilike."%电影感%"');
    expect(
      state.calls.some(
        (call) => call.method === 'eq' && call.args[0] === 'media_type' && call.args[1] === 'video'
      )
    ).toBe(true);
  });
});

describe('versioned feed cursors', () => {
  const base = {
    v: 1 as const,
    filter: feedFilter('portrait', ['肖像']),
    publishedAt: '2026-10-19T00:00:00.123456+00:00',
    id: '11111111-1111-4111-8111-111111111111',
  };
  const zero: FeedCursor = {
    ...base,
    sort: 'recommended',
    partition: 'zero',
    order: '9007199254740993',
  };
  it('round trips bigint strings above JS safe integer and timestamp microseconds', () => {
    expect(decodeFeedCursor(encodeFeedCursor(zero), 'recommended', base.filter)).toEqual(zero);
    expect(cursorFilter(zero)).toContain('initial_feed_order.gt.9007199254740993');
  });
  it('normalizes tag order but separates media cursor chains', () => {
    expect(feedFilter('x', ['b', 'a'], 'video')).toBe(feedFilter('x', ['a', 'b'], 'video'));
    expect(feedFilter('x', ['a'], 'video')).not.toBe(feedFilter('x', ['a'], 'image'));
  });
  it('continues NULL tails without revisiting numbered works', () => {
    expect(cursorFilter({ ...zero, order: null })).toBe(
      `and(initial_feed_order.is.null,or(published_at.lt.${base.publishedAt},and(published_at.eq.${base.publishedAt},id.lt.${base.id})))`
    );
  });
  it('never includes initial order in liked tie breaks', () => {
    const liked: FeedCursor = { ...base, sort: 'recommended', partition: 'liked', likeCount: 3 };
    expect(cursorFilter(liked)).not.toContain('initial_feed_order');
    expect(cursorFilter(liked)).toContain('like_count.lt.3');
  });
  it('rejects wrong filter, sort, version, bigint overflow and malformed cursor', () => {
    const encoded = encodeFeedCursor(zero);
    expect(() => decodeFeedCursor(encoded, 'latest', base.filter)).toThrow(
      'IMAGE_PLAZA_INVALID_CURSOR'
    );
    expect(() => decodeFeedCursor(encoded, 'recommended', feedFilter())).toThrow(
      'IMAGE_PLAZA_INVALID_CURSOR'
    );
    for (const value of [
      { ...zero, v: 2 },
      { ...zero, order: '9223372036854775808' },
      { ...zero, order: 1 },
      { ...zero, id: 'bad,filter' },
    ]) {
      expect(() =>
        decodeFeedCursor(
          Buffer.from(JSON.stringify(value)).toString('base64url'),
          'recommended',
          base.filter
        )
      ).toThrow('IMAGE_PLAZA_INVALID_CURSOR');
    }
    expect(() => decodeFeedCursor('invalid!', 'recommended', base.filter)).toThrow(
      'IMAGE_PLAZA_INVALID_CURSOR'
    );
  });
  it('uses a bounded ranked RPC with media/filter and rejects old recommended cursors before reads', async () => {
    state.calls = [];
    const repository = new ImagePlazaRepository();
    await repository.listWorks({
      userId: 'user-1',
      sort: 'recommended',
      media: 'video',
      limit: 20,
    });
    expect(state.calls.find((call) => call.method === 'rpc')?.args).toEqual([
      'read_image_plaza_recommended_feed',
      expect.objectContaining({ p_media: 'video', p_limit: 20, p_partition: null }),
    ]);
    state.calls = [];
    await expect(
      repository.listWorks({
        userId: 'user-1',
        sort: 'recommended',
        search: 'portrait',
        tagLabels: ['\u8096\u50cf'],
        cursor: encodeFeedCursor(zero),
        limit: 20,
      })
    ).rejects.toThrow('IMAGE_PLAZA_INVALID_CURSOR');
    expect(state.calls).toHaveLength(0);
  });
  it('latest ignores likes/order and malformed new cursors fail before reads', async () => {
    state.calls = [];
    const repository = new ImagePlazaRepository();
    await repository.listWorks({ userId: 'user-1', sort: 'latest', limit: 20 });
    expect(
      state.calls.filter((call) => call.method === 'order').map((call) => call.args[0])
    ).toEqual(['published_at', 'id']);
    state.calls = [];
    await expect(
      repository.listWorks({ userId: 'user-1', sort: 'latest', cursor: 'invalid!', limit: 20 })
    ).rejects.toThrow('IMAGE_PLAZA_INVALID_CURSOR');
    expect(state.calls).toHaveLength(0);
  });

  it('hydrates a ranked mixed partition page and continues with a revision-bound zero cursor', async () => {
    const row = (suffix: number, likes: number, order: string | null) => ({
      id: `11111111-1111-4111-8111-${String(suffix).padStart(12, '0')}`,
      artifact_id: `artifact-${suffix}`,
      title: 'Example',
      model_id: 'model',
      model_name: 'Model',
      width: 512,
      height: 512,
      tags: [],
      like_count: likes,
      initial_feed_order: order,
      published_at: base.publishedAt,
      deleted_at: null,
      snapshot: {
        prompt: 'Example',
        model_id: 'model',
        aspect_ratio: '1:1',
        resolution: '1K',
        reasoning: false,
        auto_optimize: true,
        mode: 't2i',
        reference_artifact_id: null,
        style: 'None',
      },
    });
    const liked = row(1, 3, '99');
    const firstZero = row(2, 0, '1');
    const nextZero = row(3, 0, null);
    const artifacts = [liked, firstZero, nextZero].map((item) => ({
      id: item.artifact_id,
      storage_path: 'path',
    }));
    state.calls = [];
    state.rpcResponses = [
      {
        ranking_revision: '00000000-0000-0000-0000-000000000000',
        items: [liked, firstZero, nextZero],
      },
    ];
    state.responses = [artifacts];
    const repository = new ImagePlazaRepository();
    const first = await repository.listWorks({ userId: 'owner', sort: 'recommended', limit: 2 });
    expect(first.works.map((item) => item.id)).toEqual([liked.id, firstZero.id]);
    expect(
      decodeFeedCursor(first.nextCursor ?? undefined, 'recommended', feedFilter())
    ).toMatchObject({
      v: 2,
      partition: 'zero',
      order: '1',
      rankingRevision: '00000000-0000-0000-0000-000000000000',
    });
    state.rpcResponses = [
      { ranking_revision: '00000000-0000-0000-0000-000000000000', items: [nextZero] },
    ];
    state.responses = [artifacts];
    const second = await repository.listWorks({
      userId: 'owner',
      sort: 'recommended',
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.works.map((item) => item.id)).toEqual([nextZero.id]);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.works, ...second.works].map((item) => item.id)).size).toBe(3);
    state.responses = [];
  });
});
