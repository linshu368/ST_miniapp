import { z } from 'zod';
import type { EventMeta } from './types.js';

export const GenerationCompletedPayloadSchema = z.object({
  chatId: z.number(),
  messageCount: z.number(),
});

export const generationCompletedMeta: EventMeta = {
  name: 'generation:completed',
  payloadSchema: GenerationCompletedPayloadSchema,
};
