import { z } from 'zod';
import type { EventMeta } from './types.js';

export const ChatChangedPayloadSchema = z.object({
  chatId: z.string(),
  messageCount: z.number(),
});

export const chatChangedMeta: EventMeta = {
  name: 'chat:changed',
  payloadSchema: ChatChangedPayloadSchema,
};
