import { z } from 'zod';
import type { EventMeta } from './types.js';

export const CharacterChangedPayloadSchema = z.object({
  characterId: z.number(),
  avatar: z.string(),
  chatId: z.string().nullable(),
});

export const characterChangedMeta: EventMeta = {
  name: 'character:changed',
  payloadSchema: CharacterChangedPayloadSchema,
};
