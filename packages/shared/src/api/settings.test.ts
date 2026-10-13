import { describe, expect, it } from 'vitest';
import { PatchUserSettingsRequestSchema, UserSettingsSchema } from './settings.js';
import { PatchGenerationConfigRequestSchema, UserGenerationConfigSchema } from './conversations.js';

describe('instruction-slot preference contracts', () => {
  it('keeps the two new visible preferences in both read models', () => {
    expect(
      UserSettingsSchema.parse({
        display_name: null,
        avatar_url: 'https://example.com/avatar.png',
        avatar_source: 'default',
        pref_word_count: null,
        pref_show_options: true,
        pref_show_status: true,
        pref_show_memory: true,
        pref_custom_instructions: null,
        updated_at: '2026-10-13T00:00:00.000Z',
      })
    ).toMatchObject({ pref_show_status: true, pref_show_memory: true });

    expect(
      UserGenerationConfigSchema.parse({
        selected_model_id: null,
        pref_word_count: '300-500',
        pref_show_options: true,
        pref_show_status: true,
        pref_show_memory: true,
        pref_custom_instructions: null,
      })
    ).toMatchObject({ pref_show_status: true, pref_show_memory: true });
  });

  it('keeps PATCH fields optional but rejects unknown and non-boolean slot values', () => {
    expect(PatchUserSettingsRequestSchema.parse({})).toEqual({});
    expect(PatchGenerationConfigRequestSchema.parse({ pref_show_status: false })).toEqual({
      pref_show_status: false,
    });
    expect(PatchUserSettingsRequestSchema.safeParse({ pref_show_memory: 'true' }).success).toBe(
      false
    );
    expect(PatchGenerationConfigRequestSchema.safeParse({ internal_mode: 'full' }).success).toBe(
      false
    );
  });
});
