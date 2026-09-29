import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import {
  setValidationWorkerFactoryForTests,
  validateTextPostprocessSource,
} from './validate-pool.js';

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

function evalWorker(code: string): Worker {
  return new Worker(code, { eval: true });
}

afterEach(() => {
  setValidationWorkerFactoryForTests(null);
});

describe('text postprocess validation pool', () => {
  it('compiles in the real worker and rejects an unsafe template', async () => {
    const accepted = await validateTextPostprocessSource(SOURCE, 10_000);
    expect(accepted).toMatchObject({
      ok: true,
      artifact: { schema_version: 1, policy_version: 1, rules: [{ id: 'dialogue' }] },
    });
    const rejected = await validateTextPostprocessSource(
      {
        ...SOURCE,
        rules: [{ ...SOURCE.rules[0], replacement: '<script>alert(1)</script>' }],
      },
      10_000
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok && rejected.reason === 'rejected') {
      expect(JSON.stringify(rejected.diagnostics)).not.toContain('<script>');
    } else {
      throw new Error(`expected compile rejection, received ${JSON.stringify(rejected)}`);
    }
  }, 20_000);

  it('terminates a stuck worker without blocking the caller', async () => {
    setValidationWorkerFactoryForTests(() =>
      evalWorker(`
          const { parentPort } = require('node:worker_threads');
          parentPort.on('message', () => {
            const gate = new Int32Array(new SharedArrayBuffer(4));
            Atomics.wait(gate, 0, 0, 30000);
          });
        `)
    );
    const started = Date.now();
    const result = await validateTextPostprocessSource(SOURCE, 40);
    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(1 + 1).toBe(2);
  });

  it('fails a crashed worker and a full queue immediately', async () => {
    setValidationWorkerFactoryForTests(() =>
      evalWorker(`
          const { parentPort } = require('node:worker_threads');
          parentPort.on('message', () => process.exit(1));
        `)
    );
    await expect(validateTextPostprocessSource(SOURCE, 1_000)).resolves.toEqual({
      ok: false,
      reason: 'crashed',
    });

    const pending: Promise<unknown>[] = [];
    setValidationWorkerFactoryForTests(() =>
      evalWorker(`
          const { parentPort } = require('node:worker_threads');
          parentPort.on('message', () => {
            const gate = new Int32Array(new SharedArrayBuffer(4));
            Atomics.wait(gate, 0, 0, 30000);
          });
        `)
    );
    for (let index = 0; index < 66; index += 1) {
      pending.push(validateTextPostprocessSource({ index }, 5_000));
    }
    const started = Date.now();
    await expect(validateTextPostprocessSource({ overflow: true }, 5_000)).resolves.toEqual({
      ok: false,
      reason: 'queue_full',
    });
    expect(Date.now() - started).toBeLessThan(200);
    setValidationWorkerFactoryForTests(null);
    await Promise.allSettled(pending);
  });
});
