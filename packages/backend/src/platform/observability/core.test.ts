import { describe, expect, it, vi } from 'vitest';
import { createObserver } from './core.js';
import { currentContext, newContext, requestId, withContext } from './context.js';
import { safeError, safeFields, type ObservationEvent } from './events.js';

describe('observation execution boundaries', () => {
  it('isolates overlapping requests and nests child operations without losing the parent', async () => {
    const records: ObservationEvent[] = [];
    const observer = createObserver([
      (record) => {
        records.push(record);
      },
    ]);
    const roots = [newContext('request-a'), newContext('request-b')];
    await Promise.all(
      roots.map((root) =>
        withContext(root, () =>
          observer.observe('test.outer', async () => {
            const parent = currentContext();
            await new Promise((resolve) => setTimeout(resolve, 1));
            await observer.observe('test.inner', async () => root.request_id);
            expect(currentContext()).toBe(parent);
            return root;
          })
        )
      )
    );
    expect(currentContext()).toBeUndefined();
    for (const root of roots) {
      const group = records.filter((record) => record.request_id === root.request_id);
      expect(group).toHaveLength(4);
      expect(group.every((record) => record.trace_id === root.trace_id)).toBe(true);
      const outer = group.find((record) => record.operation === 'test.outer')!;
      const inner = group.find((record) => record.operation === 'test.inner')!;
      expect(outer.parent_span_id).toBe(root.span_id);
      expect(inner.parent_span_id).toBe(outer.span_id);
    }
  });

  it('executes exactly once and preserves values and thrown objects across sink failures', async () => {
    const observer = createObserver([
      () => {
        throw new Error('sink');
      },
      async () => {
        throw new Error('async sink');
      },
    ]);
    const value = {};
    const run = vi.fn(() => value);
    expect(observer.observeSync('test.sync', run)).toBe(value);
    expect(run).toHaveBeenCalledTimes(1);
    const error = { reason: 'original' };
    expect(() =>
      observer.observeSync('test.throw', () => {
        throw error;
      })
    ).toThrow();
    await expect(
      observer.observe('test.reject', async () => {
        throw error;
      })
    ).rejects.toBe(error);
    await expect(observer.observe('test.value', async () => value)).resolves.toBe(value);
    await Promise.resolve();
    expect(observer.health.output_failures).toBeGreaterThan(0);
  });

  it('records one terminal despite repeated finish and does not turn projection failure into business failure', () => {
    const records: ObservationEvent[] = [];
    const observer = createObserver([
      (record) => {
        records.push(record);
      },
    ]);
    const op = observer.start('test.once');
    op.finish({ outcome: 'cancelled' });
    op.finish({ outcome: 'succeeded' });
    expect(records.map((record) => record.outcome)).toEqual(['pending', 'cancelled']);
    const value = {};
    expect(
      observer.observeSync(
        'test.projection',
        () => value,
        () => {
          throw new Error();
        }
      )
    ).toBe(value);
    expect(records.at(-1)?.outcome).toBe('unknown');
    expect(observer.health.projection_failures).toBe(1);
  });
});

describe('safe event projection', () => {
  it('drops raw fields and error text, preserves only bounded source locations and causes', () => {
    const error = new Error('secret private-content', { cause: new Error('secret') });
    error.stack =
      'Error: secret\n    at method (C:\\source\\service.ts:23:4)\n    at https://example.invalid/private?token=secret:1:2';
    error.cause = error;
    const projected = safeFields({
      err: error,
      route: '/api?token=secret',
      duration_ms: Infinity,
      ...{ body: 'secret', token: 'secret' },
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('private-content');
    expect(serialized).not.toContain('body');
    expect(serialized).toContain('service.ts:23:4');
    expect(serialized.length).toBeLessThan(2000);
    expect(projected.duration_ms).toBeUndefined();
    expect(projected.route).toBe('unknown');
  });

  it('survives unreadable errors and rejects malformed or oversized external correlation IDs', () => {
    const error = new Error();
    Object.defineProperty(error, 'stack', {
      get() {
        throw new Error();
      },
    });
    expect(safeError(error).message).toBe('Unreadable error');
    expect(requestId('request_123-abc')).toBe('request_123-abc');
    for (const value of ['x'.repeat(129), ['header'], '', 'a\nb', '?token=secret']) {
      expect(requestId(value)).toMatch(/^[a-f0-9-]{36}$/);
    }
  });
});
