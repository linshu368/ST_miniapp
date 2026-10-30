import { readFile } from 'node:fs/promises';
import {
  CREATOR_PRESET_CATALOG,
  CreatorPresetIdSchema,
  type CreatorPresetId,
} from '@miniapp/shared';

const FILES: Record<CreatorPresetId, string> = {
  'world-causality': 'collection_1.txt',
  'living-npcs': 'collection_2.txt',
  'player-boundaries': 'collection_3.txt',
  'gradual-intimacy': 'collection_4.txt',
};
const contentCache = new Map<CreatorPresetId, Promise<string>>();

/** Server-only static assets. The client supplies fixed IDs, never paths or trusted rule text. */
export async function resolveCreatorPresets(
  selectedIds: readonly CreatorPresetId[]
): Promise<Array<{ title: string; content: string }>> {
  const selected = new Set(selectedIds.map((id) => CreatorPresetIdSchema.parse(id)));
  return Promise.all(
    CREATOR_PRESET_CATALOG.filter((preset) => selected.has(preset.id)).map(async (preset) => {
      let content = contentCache.get(preset.id);
      if (!content) {
        content = readFile(new URL(`./presets/${FILES[preset.id]}`, import.meta.url), 'utf8')
          .then((text) => {
            if (!text.trim()) throw new Error('creator_preset_empty');
            return text;
          })
          .catch((error: unknown) => {
            contentCache.delete(preset.id);
            throw new Error('creator_preset_unavailable', { cause: error });
          });
        contentCache.set(preset.id, content);
      }
      return { title: preset.title, content: await content };
    })
  );
}
