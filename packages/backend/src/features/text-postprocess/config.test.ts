import { describe, expect, it } from 'vitest';
import type { RuntimeConfigEntry } from '../../platform/runtime-config.js';
import { readAdminPostprocessVersion } from './config.js';

function entry(value: unknown, version = 4): RuntimeConfigEntry {
  return { value, textValue: null, version };
}

const published = {
  version: 4,
  schema_version: 1,
  policy_version: 1,
  source: { schema_version: 1, policy_version: 1, rules: [] },
  published_at: '2026-09-28T00:00:00.000Z',
};

describe('readAdminPostprocessVersion', () => {
  it('returns the validated runtime pointer without substituting another version', async () => {
    await expect(readAdminPostprocessVersion(1_000, async () => entry(published))).resolves.toBe(4);
    await expect(
      readAdminPostprocessVersion(1_000, async () => entry({ ...published, policy_version: 9 }))
    ).resolves.toBeNull();
  });

  it('fails an admin config read on timeout instead of pretending nothing is published', async () => {
    let signal: AbortSignal | undefined;
    await expect(
      readAdminPostprocessVersion(10, (_key, nextSignal) => {
        signal = nextSignal;
        return new Promise(() => undefined);
      })
    ).rejects.toThrow(/timed out/);
    expect(signal?.aborted).toBe(true);
  });
});
