import { z } from 'zod';
import type { ActionMeta } from './types.js';

export const NewChatPayloadSchema = z.object({});

export const NewChatResultSchema = z.object({
  chatId: z.string(),
});

export const newChatMeta: ActionMeta = {
  name: 'newChat',
  payloadSchema: NewChatPayloadSchema,
  resultSchema: NewChatResultSchema,
  requiredPhase: 'ready',
  waitable: true,
};
