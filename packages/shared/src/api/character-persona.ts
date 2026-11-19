import { z } from 'zod';

/** 与 migration 20261118_character_persona.sql 的 CHECK 同步。 */
export const CHARACTER_NOTES_MAX_LENGTH = 1000;
export const PERSONA_NAME_MAX_LENGTH = 20;
export const PERSONA_DESCRIPTION_MAX_LENGTH = 800;
export const PERSONA_MAX_COUNT = 10;

/** 用户的一个主角人设。name 只给用户自己区分，description 才会进 prompt。 */
export interface UserPersona {
  id: string;
  name: string;
  description: string;
  is_default: boolean;
}

/**
 * 某张角色卡上的人设选择：
 * - default：跟随默认人设（没有默认则不使用）；
 * - none：这张卡不使用任何人设；
 * - persona：指定 persona_id。
 */
export type CharacterPersonaChoice =
  | { mode: 'default'; persona_id: null }
  | { mode: 'none'; persona_id: null }
  | { mode: 'persona'; persona_id: string };

// ==== GET /api/characters/:characterId/my-settings ====
export interface GetCharacterMySettingsData {
  /** 用户为这张卡补充的设定，没写过为空串。 */
  notes: string;
  persona: CharacterPersonaChoice;
  /** 用户的全部人设（人设库全局，选择按卡记）。 */
  personas: UserPersona[];
}

export const CharacterPersonaChoiceSchema: z.ZodType<CharacterPersonaChoice> = z.discriminatedUnion(
  'mode',
  [
    z.object({ mode: z.literal('default'), persona_id: z.null() }),
    z.object({ mode: z.literal('none'), persona_id: z.null() }),
    z.object({ mode: z.literal('persona'), persona_id: z.string().uuid() }),
  ]
);

// ==== PUT /api/characters/:characterId/my-settings（部分更新）====
export interface PutCharacterMySettingsRequest {
  notes?: string;
  persona?: CharacterPersonaChoice;
}

export const PutCharacterMySettingsRequestSchema: z.ZodType<PutCharacterMySettingsRequest> = z
  .object({
    notes: z.string().max(CHARACTER_NOTES_MAX_LENGTH).optional(),
    persona: CharacterPersonaChoiceSchema.optional(),
  })
  .strict()
  .refine((value) => value.notes !== undefined || value.persona !== undefined, {
    message: 'notes 或 persona 至少提供一个',
  });

// ==== POST /api/personas、PATCH /api/personas/:id（整对象保存）====
export interface SavePersonaRequest {
  name: string;
  description: string;
  is_default: boolean;
}

export const SavePersonaRequestSchema: z.ZodType<SavePersonaRequest> = z
  .object({
    name: z.string().trim().min(1).max(PERSONA_NAME_MAX_LENGTH),
    description: z.string().trim().min(1).max(PERSONA_DESCRIPTION_MAX_LENGTH),
    is_default: z.boolean(),
  })
  .strict();

export interface SavePersonaData {
  persona: UserPersona;
}

export interface DeletePersonaData {
  deleted: boolean;
}
