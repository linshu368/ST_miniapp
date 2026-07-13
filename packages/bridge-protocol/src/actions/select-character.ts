import { z } from 'zod';
import type { ActionMeta } from './types.js';

export const SelectCharacterPayloadSchema = z.object({
  avatar: z.string(),
  forceNewChat: z.boolean().optional(),
});

export const SelectCharacterResultSchema = z.object({
  characterId: z.number(),
  chatId: z.string().nullable(),
});

export const selectCharacterMeta: ActionMeta = {
  name: 'selectCharacter',
  payloadSchema: SelectCharacterPayloadSchema,
  resultSchema: SelectCharacterResultSchema,
  requiredPhase: 'interactive',
  waitable: true,
};
