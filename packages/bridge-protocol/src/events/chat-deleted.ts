import { z } from 'zod';
import type { EventMeta } from './types.js';

export const ChatDeletedPayloadSchema = z.object({
  fileName: z.string(),
});

export const chatDeletedMeta: EventMeta = {
  name: 'chat:deleted',
  payloadSchema: ChatDeletedPayloadSchema,
};
