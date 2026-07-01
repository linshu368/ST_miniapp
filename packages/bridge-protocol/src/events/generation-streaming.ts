import { z } from 'zod';
import type { EventMeta } from './types.js';

export const GenerationStreamingPayloadSchema = z.object({
  phase: z.literal('streaming'),
});

export const generationStreamingMeta: EventMeta = {
  name: 'generation:streaming',
  payloadSchema: GenerationStreamingPayloadSchema,
};
