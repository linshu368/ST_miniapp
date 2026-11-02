import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CREATOR_PRESET_CATALOG, type CreatorPresetId } from '@miniapp/shared';
import { resolveCreatorPresets } from './preset-catalog.js';

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
describe('server-only creator preset resolution', () => {
  it('resolves all selected rules in catalog order and preserves private file content exactly', async () => {
    const values = await resolveCreatorPresets(
      [...CREATOR_PRESET_CATALOG].reverse().map((preset) => preset.id)
    );
    expect(values.map((value) => value.title)).toEqual(
      CREATOR_PRESET_CATALOG.map((preset) => preset.title)
    );
    for (let index = 0; index < values.length; index++) {
      const source = await readFile(
        new URL(`./presets/collection_${index + 1}.txt`, import.meta.url),
        'utf8'
      );
      // Digests make a failed preservation check safe to report without printing private rules.
      expect(digest(values[index]!.content)).toBe(digest(source));
    }
  });
  it('keeps custom-only cards independent of static files and rejects untrusted identities', async () => {
    expect(await resolveCreatorPresets([])).toEqual([]);
    await expect(resolveCreatorPresets(['../../secret' as CreatorPresetId])).rejects.toThrow();
  });
});
