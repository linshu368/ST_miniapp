import { describe, expect, it } from 'vitest';
import type { RuntimeConfigEntry } from '../../platform/runtime-config.js';
import { TEXT_POSTPROCESS_CONFIG_KEY } from './constants.js';
import { readAdminPostprocessVersion, readCurrentPostprocessVersion } from './config.js';

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

describe('readCurrentPostprocessVersion', () => {
  it('returns null when the config row is missing', async () => {
    const keys: string[] = [];
    const version = await readCurrentPostprocessVersion({
      read: async (key) => {
        keys.push(key);
        return null;
      },
    });
    expect(version).toBeNull();
    expect(keys).toEqual([TEXT_POSTPROCESS_CONFIG_KEY]);
  });

  it('returns null for an illegal payload or a version that disagrees with the row', async () => {
    await expect(
      readCurrentPostprocessVersion({ read: async () => entry(published, 9) })
    ).resolves.toBeNull();
    await expect(
      readCurrentPostprocessVersion({
        read: async () => entry({ ...published, schema_version: 2 }, 4),
      })
    ).resolves.toBeNull();
    await expect(
      readCurrentPostprocessVersion({
        read: async () => entry({ ...published, policy_version: 9 }, 4),
      })
    ).resolves.toBeNull();
    await expect(
      readCurrentPostprocessVersion({ read: async () => entry({ version: '4' }, 4) })
    ).resolves.toBeNull();
  });

  it('returns the published version when schema, policy, and the row version agree', async () => {
    await expect(
      readCurrentPostprocessVersion({ read: async () => entry(published, 4) })
    ).resolves.toBe(4);
  });

  it('returns null on timeout or a thrown read and does not retry', async () => {
    let calls = 0;
    const version = await readCurrentPostprocessVersion({
      timeoutMs: 20,
      read: () => {
        calls += 1;
        return new Promise(() => undefined);
      },
    });
    expect(version).toBeNull();
    expect(calls).toBe(1);

    calls = 0;
    await expect(
      readCurrentPostprocessVersion({
        read: async () => {
          calls += 1;
          throw new Error('db down');
        },
      })
    ).resolves.toBeNull();
    expect(calls).toBe(1);
  });

  it('fails an admin config read on timeout instead of pretending nothing is published', async () => {
    await expect(
      readAdminPostprocessVersion(20, () => new Promise(() => undefined))
    ).rejects.toThrow(/timed out/);
    await expect(
      readAdminPostprocessVersion(1_000, async () => entry({ ...published, schema_version: 2 }, 4))
    ).resolves.toBeNull();
  });
});
