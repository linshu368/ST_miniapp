import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPrismaObservation } from './prisma.js';
import { createObserver } from './core.js';
import { observation } from './runtime.js';
import type { ObservationEvent } from './events.js';

type Invocation = { args: unknown; query: (args: unknown) => Promise<unknown> };
type Definition = {
  query: {
    $allModels: {
      $allOperations: (
        input: Invocation & { model: string; operation: string }
      ) => Promise<unknown>;
    };
    $queryRaw: (input: Invocation) => Promise<unknown>;
    $executeRaw: (input: Invocation) => Promise<unknown>;
    $queryRawUnsafe: (input: Invocation) => Promise<unknown>;
    $executeRawUnsafe: (input: Invocation) => Promise<unknown>;
  };
};

afterEach(() => vi.restoreAllMocks());

describe('Prisma observation for shared and dedicated clients', () => {
  it('uses the existing client extension for all model/raw operations and keeps results/arguments', async () => {
    const extended = {};
    const extend = vi.fn((_definition: Definition) => extended);
    expect(applyPrismaObservation({ $extends: extend } as unknown as PrismaClient)).toBe(extended);
    expect(extend).toHaveBeenCalledOnce();
    const hooks = extend.mock.calls[0]![0].query;
    const records: ObservationEvent[] = [];
    vi.spyOn(observation, 'start').mockImplementation(
      createObserver([
        (event) => {
          records.push(event);
        },
      ]).start
    );
    const args = { sql: 'private-sql', parameters: ['private-value'] };
    const result = Object.freeze({ rows: ['private-result'] });
    const query = vi.fn().mockResolvedValue(result);
    expect(
      await hooks.$allModels.$allOperations({
        model: 'TestModel',
        operation: 'findMany',
        args,
        query,
      })
    ).toBe(result);
    for (const hook of [
      hooks.$queryRaw,
      hooks.$executeRaw,
      hooks.$queryRawUnsafe,
      hooks.$executeRawUnsafe,
    ])
      expect(await hook({ args, query })).toBe(result);
    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls.every(([received]) => received === args)).toBe(true);
    expect(records.filter((event) => event.event === 'operation.terminal')).toHaveLength(5);
    expect(JSON.stringify(records)).not.toContain('private');
    const failure = new Error('private-database-error');
    query.mockRejectedValueOnce(failure);
    await expect(hooks.$queryRaw({ args, query })).rejects.toBe(failure);
    expect(records.at(-1)).toMatchObject({ outcome: 'failed', outcome_known: false });
    expect(JSON.stringify(records)).not.toContain('private');
  });
});
