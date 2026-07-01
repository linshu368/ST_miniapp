import { z } from 'zod';
import type { EventMeta } from './types.js';

export const ChatCreatedPayloadSchema = z.object({
  chatId: z.string(),
});

export const chatCreatedMeta: EventMeta = {
  name: 'chat:created',
  payloadSchema: ChatCreatedPayloadSchema,
};
