import { describe, expect, it } from 'vitest';
import {
  CHARACTER_NOTES_MAX_LENGTH,
  PERSONA_DESCRIPTION_MAX_LENGTH,
  PERSONA_NAME_MAX_LENGTH,
  PutCharacterMySettingsRequestSchema,
  SavePersonaRequestSchema,
} from './character-persona';

const UUID = '3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b';

describe('PutCharacterMySettingsRequestSchema', () => {
  it('接受只改补充设定或只改人设选择', () => {
    expect(PutCharacterMySettingsRequestSchema.safeParse({ notes: '小红：侍女' }).success).toBe(
      true
    );
    expect(
      PutCharacterMySettingsRequestSchema.safeParse({
        persona: { mode: 'persona', persona_id: UUID },
      }).success
    ).toBe(true);
    expect(
      PutCharacterMySettingsRequestSchema.safeParse({ persona: { mode: 'none', persona_id: null } })
        .success
    ).toBe(true);
  });

  it('空请求、超长补充设定、非法人设选择被拒绝', () => {
    expect(PutCharacterMySettingsRequestSchema.safeParse({}).success).toBe(false);
    expect(
      PutCharacterMySettingsRequestSchema.safeParse({
        notes: 'a'.repeat(CHARACTER_NOTES_MAX_LENGTH + 1),
      }).success
    ).toBe(false);
    expect(
      PutCharacterMySettingsRequestSchema.safeParse({
        persona: { mode: 'persona', persona_id: null },
      }).success
    ).toBe(false);
    expect(
      PutCharacterMySettingsRequestSchema.safeParse({
        persona: { mode: 'persona', persona_id: 'x' },
      }).success
    ).toBe(false);
  });
});

describe('SavePersonaRequestSchema', () => {
  it('按长度上限校验，并去掉首尾空白', () => {
    const ok = SavePersonaRequestSchema.safeParse({
      name: ' 书生 ',
      description: ' 落魄 ',
      is_default: true,
    });
    expect(ok.success && ok.data).toEqual({ name: '书生', description: '落魄', is_default: true });
    expect(
      SavePersonaRequestSchema.safeParse({
        name: 'a'.repeat(PERSONA_NAME_MAX_LENGTH + 1),
        description: 'x',
        is_default: false,
      }).success
    ).toBe(false);
    expect(
      SavePersonaRequestSchema.safeParse({
        name: 'a',
        description: 'x'.repeat(PERSONA_DESCRIPTION_MAX_LENGTH + 1),
        is_default: false,
      }).success
    ).toBe(false);
    expect(
      SavePersonaRequestSchema.safeParse({ name: '  ', description: 'x', is_default: false })
        .success
    ).toBe(false);
  });
});
