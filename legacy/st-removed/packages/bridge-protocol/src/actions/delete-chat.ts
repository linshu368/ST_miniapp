import { z } from 'zod';
import type { ActionMeta } from './types.js';

export const DeleteChatPayloadSchema = z.object({
  fileName: z.string(),
  avatar: z.string(),
});

export const DeleteChatResultSchema = z.object({
  switchedToChatId: z.string().nullable(),
});

export const deleteChatMeta: ActionMeta = {
  name: 'deleteChat',
  payloadSchema: DeleteChatPayloadSchema,
  resultSchema: DeleteChatResultSchema,
  requiredPhase: 'ready',
  waitable: true,
};
