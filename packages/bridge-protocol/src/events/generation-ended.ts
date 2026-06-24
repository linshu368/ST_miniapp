import { z } from 'zod';
import type { EventMeta } from './types.js';

export const GenerationEndedPayloadSchema = z.object({
  chatLength: z.number(),
});

export const generationEndedMeta: EventMeta = {
  name: 'generation:ended',
  payloadSchema: GenerationEndedPayloadSchema,
};
