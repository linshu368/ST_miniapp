import { beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { method: string; args: unknown[] };

const state = vi.hoisted(() => ({
  calls: [] as Call[],
}));

function createThenableBuilder() {
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
    'eq',
    'in',
  ] as const) {
    builder[method] = track(method);
  }
  // Supabase query builders are thenable; empty page skips hydrate.
  builder.then = (
    onFulfilled?: (value: { data: unknown[]; error: null }) => unknown,
    onRejected?: (reason: unknown) => unknown
  ) => Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected);
  return builder;
}

vi.mock('../../lib/supabase.js', () => ({
  getDomainDb: (schema: string) => {
    if (schema === 'experience') {
      return {
        from: (table: string) => {
          state.calls.push({ method: 'from', args: [table] });
          return createThenableBuilder();
        },
      };
    }
    return {
      from: () => createThenableBuilder(),
      rpc: vi.fn(),
    };
  },
}));

vi.mock('./storage.js', () => ({
  deletePlazaImage: vi.fn(),
  downloadPlazaImage: vi.fn(),
  signPlazaImagePath: vi.fn(),
  uploadPlazaImage: vi.fn(),
}));

const { ImagePlazaRepository } = await import('./repository.js');

describe('ImagePlazaRepository.listWorks tagLabel filter', () => {
  beforeEach(() => {
    state.calls = [];
  });

  it('filters prompt_zh with escaped ILIKE pattern and does not use tags contains', async () => {
    const repository = new ImagePlazaRepository();
    await repository.listWorks({
      userId: 'user-1',
      tagLabel: '人像_50%',
      limit: 20,
    });

    expect(state.calls.some((call) => call.method === 'contains')).toBe(false);
    const filterCall = state.calls.find((call) => call.method === 'filter');
    expect(filterCall?.args).toEqual(['snapshot->>prompt_zh', 'ilike', '%人像\\_50\\%%']);
  });

  it('does not apply tag filter when tagLabel is omitted (全部)', async () => {
    const repository = new ImagePlazaRepository();
    await repository.listWorks({ userId: 'user-1', limit: 20 });

    expect(state.calls.some((call) => call.method === 'filter')).toBe(false);
    expect(state.calls.some((call) => call.method === 'contains')).toBe(false);
  });

  it('ANDs search or-clause with tagLabel filter', async () => {
    const repository = new ImagePlazaRepository();
    await repository.listWorks({
      userId: 'user-1',
      search: '猫',
      tagLabel: '动漫',
      limit: 20,
    });

    const orCall = state.calls.find((call) => call.method === 'or');
    expect(String(orCall?.args[0])).toContain('snapshot->>prompt.ilike.');
    expect(String(orCall?.args[0])).toContain('snapshot->>prompt_zh.ilike.');
    expect(state.calls.find((call) => call.method === 'filter')?.args).toEqual([
      'snapshot->>prompt_zh',
      'ilike',
      '%动漫%',
    ]);
  });
});
