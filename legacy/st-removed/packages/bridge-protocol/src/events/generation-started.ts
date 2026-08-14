import { z } from 'zod';
import type { EventMeta } from './types.js';

export const GenerationStartedPayloadSchema = z.object({
  type: z.string(),
});

export const generationStartedMeta: EventMeta = {
  name: 'generation:started',
  payloadSchema: GenerationStartedPayloadSchema,
};
