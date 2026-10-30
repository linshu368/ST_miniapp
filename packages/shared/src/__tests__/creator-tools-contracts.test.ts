import { describe, expect, it } from 'vitest';
import { parseCreatorCoverReturn, CreatorCoverRequestSchema } from '../api/creator-tools.js';
const id = '70000000-0000-4000-8000-000000000001';
describe('creator cover return boundaries', () => {
  it('allows only the originating editor with its stable draft id', () => {
    expect(parseCreatorCoverReturn(`/creation/characters/new?draft=${id}`)).toBe(
      `/creation/characters/new?draft=${id}`
    );
    expect(parseCreatorCoverReturn(`/creation/characters/${id}/edit`)).toBe(
      `/creation/characters/${id}/edit`
    );
  });
  it.each([
    'https://evil.invalid/',
    '//evil.invalid',
    '/creation/characters/new',
    `/creation/characters/new?draft=${id}&return=https://evil.invalid`,
    `/creation/characters/${id}/edit?unexpected=1`,
    '/creation/characters/../../profile',
  ])('rejects unexpected return target %s', (value) => {
    expect(parseCreatorCoverReturn(value)).toBeNull();
  });
  it('cannot create a cover from an arbitrary network URL', () => {
    expect(
      CreatorCoverRequestSchema.safeParse({ id, source: 'url', url: 'https://evil.invalid' })
        .success
    ).toBe(false);
    expect(
      CreatorCoverRequestSchema.safeParse({
        id,
        source: 'artifact',
        artifact_id: id,
        url: 'https://evil.invalid',
      }).success
    ).toBe(false);
  });
});

import {
  CharacterDraftSchema,
  CREATOR_PRESET_CATALOG,
  composeCharacterSystemPrompt,
  emptyCharacterDraft,
} from '../api/creator-characters.js';

describe('creator preset contract and fixed assembly', () => {
  it('restores legacy drafts without selection and keeps multiple independent choices', () => {
    const { selectedPresetIds: _ignored, ...legacy } = emptyCharacterDraft();
    expect(CharacterDraftSchema.parse(legacy).selectedPresetIds).toEqual([]);
    expect(
      CharacterDraftSchema.parse({
        ...legacy,
        selectedPresetIds: ['world-causality', 'living-npcs'],
      }).selectedPresetIds
    ).toHaveLength(2);
    expect(
      CharacterDraftSchema.safeParse({
        ...legacy,
        selectedPresetIds: ['world-causality', 'world-causality'],
      }).success
    ).toBe(false);
    expect(
      CharacterDraftSchema.safeParse({ ...legacy, selectedPresetIds: ['../../secret'] }).success
    ).toBe(false);
  });
  it('exports public metadata only, not rule content or server file paths', () => {
    expect(CREATOR_PRESET_CATALOG).toHaveLength(4);
    for (const item of CREATOR_PRESET_CATALOG) {
      expect(Object.keys(item).sort()).toEqual(['effect', 'id', 'title', 'use_cases']);
    }
  });
  it('places resolved selections before custom presets/files and background without rewriting source', () => {
    const draft = {
      ...emptyCharacterDraft(),
      preset: ' custom source ',
      background: 'background source',
      presetFiles: [{ id: 'p', name: 'preset.txt', content: 'preset file' }],
      backgroundFiles: [{ id: 'b', name: 'background.txt', content: 'background file' }],
    };
    const result = composeCharacterSystemPrompt(draft, [
      { title: 'first selection', content: ' rule one\n' },
      { title: 'second selection', content: 'rule two' },
    ]);
    const ordered = [
      ' rule one\n',
      'rule two',
      ' custom source ',
      'preset file',
      '## 背景',
      'background source',
      'background file',
    ];
    for (let index = 1; index < ordered.length; index++)
      expect(result.indexOf(ordered[index]!)).toBeGreaterThan(result.indexOf(ordered[index - 1]!));
  });
});
