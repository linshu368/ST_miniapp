import { z } from 'zod';
import type { ActionMeta } from './types.js';

export const OpenChatPayloadSchema = z.object({
  fileName: z.string(),
});

export const OpenChatResultSchema = z.object({
  chatId: z.string(),
});

export const openChatMeta: ActionMeta = {
  name: 'openChat',
  payloadSchema: OpenChatPayloadSchema,
  resultSchema: OpenChatResultSchema,
  requiredPhase: 'ready',
  waitable: true,
};
