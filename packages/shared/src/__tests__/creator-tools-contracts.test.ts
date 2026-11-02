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

import {
  CreatorAiReviewResultSchema,
  CreatorReviewTestRequestSchema,
  CreatorReviewTestDataSchema,
  CreatorReviewPromptSchema,
  DEFAULT_CREATOR_REVIEW_PROMPT,
  CREATOR_REVIEW_OUTPUT_JSON_SCHEMA,
  PublishCreatorCharacterSchema,
} from '../api/creator-characters.js';

describe('creator AI review fixed contract', () => {
  it('accepts exactly the two stable result fields and keeps the prompt editable', () => {
    expect(
      CreatorAiReviewResultSchema.parse({ approved: false, reason: '请补充可以互动的角色背景。' })
    ).toEqual({ approved: false, reason: '请补充可以互动的角色背景。' });
    expect(CreatorAiReviewResultSchema.parse({ approved: true, reason: '符合要求' }).approved).toBe(
      true
    );
    expect(CreatorReviewPromptSchema.parse(DEFAULT_CREATOR_REVIEW_PROMPT)).toBe(
      DEFAULT_CREATOR_REVIEW_PROMPT
    );
    expect(CreatorReviewPromptSchema.parse('运营自行定义审核准则')).toBe('运营自行定义审核准则');
    expect(CREATOR_REVIEW_OUTPUT_JSON_SCHEMA.required).toEqual(['approved', 'reason']);
    expect(CREATOR_REVIEW_OUTPUT_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(Object.keys(CREATOR_REVIEW_OUTPUT_JSON_SCHEMA.properties)).toEqual([
      'approved',
      'reason',
    ]);
  });
  it.each([
    {},
    { approved: true },
    { reason: '缺字段' },
    { approved: '是', reason: '类型错误' },
    { approved: false, reason: '' },
    { approved: false, reason: '   ' },
    { approved: true, reason: '通过', extra: '不允许额外字段' },
  ])('rejects malformed model output %j', (value) => {
    expect(CreatorAiReviewResultSchema.safeParse(value).success).toBe(false);
  });
  it('does not let the browser supply its own approval result', () => {
    expect(
      PublishCreatorCharacterSchema.safeParse({
        expected_revision: 1,
        visibility: 'public',
        review: { approved: true, reason: '伪造审核' },
      }).success
    ).toBe(false);
  });
});

describe('creator review Admin dry-run contract', () => {
  const input = {
    prompt: '编辑中的规则',
    material: { name: '', description: '', opening: '', tags: [], systemPrompt: '测试资料' },
  };
  it('supports a single text sample while requiring nonempty test material and policy', () => {
    expect(CreatorReviewTestRequestSchema.parse(input)).toEqual(input);
    expect(CreatorReviewTestRequestSchema.safeParse({ ...input, prompt: '' }).success).toBe(false);
    expect(
      CreatorReviewTestRequestSchema.safeParse({
        ...input,
        material: { ...input.material, systemPrompt: '  ' },
      }).success
    ).toBe(false);
    expect(
      CreatorReviewTestRequestSchema.safeParse({
        ...input,
        result: { approved: true, reason: 'fake' },
      }).success
    ).toBe(false);
  });

  it('keeps the returned dry-run result strictly within the same public review result protocol', () => {
    expect(
      CreatorReviewTestDataSchema.parse({ result: { approved: false, reason: '样本未通过' } })
    ).toEqual({
      result: { approved: false, reason: '样本未通过' },
    });
    expect(
      CreatorReviewTestDataSchema.safeParse({
        result: { approved: true, reason: '通过', score: 100 },
      }).success
    ).toBe(false);
    expect(
      CreatorReviewTestDataSchema.safeParse({
        result: { approved: true, reason: '通过' },
        raw: 'provider body',
      }).success
    ).toBe(false);
  });
});
