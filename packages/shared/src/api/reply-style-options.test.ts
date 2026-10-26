import { describe, expect, it } from 'vitest';
import {
  ReplyStyleOptionsConfigSchema,
  ReplyStylePreferencesSchema,
  PublicReplyStyleOptionSchema,
} from './reply-style-options.js';
import { PatchGenerationConfigRequestSchema, UserGenerationConfigSchema } from './conversations.js';
import { PatchUserSettingsRequestSchema } from './settings.js';
const option = {
  id: 'style-example',
  name: '示例',
  description: '说明',
  marker: '',
  rules: '',
  enabled: true,
};

describe('reply style UI contracts', () => {
  it('accepts an empty catalog and blank operator-authored fields', () => {
    expect(ReplyStyleOptionsConfigSchema.parse({ options: [] })).toEqual({ options: [] });
    expect(
      ReplyStyleOptionsConfigSchema.parse({
        options: [{ ...option, name: ' 示例 ', marker: '  ', rules: ' ' }],
      }).options[0]
    ).toEqual(option);
  });
  it('rejects duplicate identities/markers and malformed catalog entries', () => {
    expect(ReplyStyleOptionsConfigSchema.safeParse({ options: [option, option] }).success).toBe(
      false
    );
    expect(
      ReplyStyleOptionsConfigSchema.safeParse({
        options: [
          { ...option, marker: 'SAME' },
          { ...option, id: 'style-second', marker: 'SAME' },
        ],
      }).success
    ).toBe(false);
    for (const patch of [
      { name: '' },
      { id: 'constructor' },
      { rules: 'a'.repeat(12001) },
      { enabled: 'true' },
      { extra: 1 },
    ])
      expect(
        ReplyStyleOptionsConfigSchema.safeParse({ options: [{ ...option, ...patch }] }).success
      ).toBe(false);
    expect(
      ReplyStyleOptionsConfigSchema.safeParse({
        options: Array.from({ length: 25 }, (_, i) => ({ ...option, id: `style-${i}` })),
      }).success
    ).toBe(false);
  });
  it('keeps private configuration out of the public metadata shape', () => {
    expect(PublicReplyStyleOptionSchema.safeParse(option).success).toBe(false);
    expect(
      PublicReplyStyleOptionSchema.parse({
        id: option.id,
        name: option.name,
        description: option.description,
      })
    ).toEqual({ id: option.id, name: option.name, description: option.description });
  });
  it('accepts all independent combinations and optional legacy preferences', () => {
    for (let mask = 0; mask < 16; mask++) {
      const map = Object.fromEntries(
        Array.from({ length: 4 }, (_, i) => [`style-${i}`, Boolean(mask & (1 << i))])
      );
      expect(ReplyStylePreferencesSchema.parse(map)).toEqual(map);
      expect(PatchGenerationConfigRequestSchema.parse({ pref_reply_styles: map })).toEqual({
        pref_reply_styles: map,
      });
      expect(PatchUserSettingsRequestSchema.parse({ pref_reply_styles: map })).toEqual({
        pref_reply_styles: map,
      });
    }
    const legacy = {
      selected_model_id: null,
      pref_word_count: '300-500',
      pref_show_options: true,
      pref_show_status: true,
      pref_show_memory: true,
      pref_custom_instructions: null,
    };
    expect(UserGenerationConfigSchema.parse(legacy).pref_reply_styles).toBeUndefined();
  });
  it('rejects nonboolean, invalid identity, oversized maps and rule text in a public patch', () => {
    for (const value of [
      null,
      [],
      { 'style-example': 'true' },
      { constructor: true },
      Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`style-${i}`, false])),
    ])
      expect(ReplyStylePreferencesSchema.safeParse(value).success).toBe(false);
    expect(PatchGenerationConfigRequestSchema.safeParse({ rules: 'private' }).success).toBe(false);
  });
});
