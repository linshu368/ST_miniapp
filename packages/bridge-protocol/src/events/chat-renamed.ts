import { z } from 'zod';
import type { EventMeta } from './types.js';

export const ChatRenamedPayloadSchema = z.object({
  oldFileName: z.string(),
  newFileName: z.string(),
});

export const chatRenamedMeta: EventMeta = {
  name: 'chat:renamed',
  payloadSchema: ChatRenamedPayloadSchema,
};
