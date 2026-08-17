import { z } from 'zod';
import type { EventMeta } from './types.js';

export const GenerationStoppedPayloadSchema = z.object({});

export const generationStoppedMeta: EventMeta = {
  name: 'generation:stopped',
  payloadSchema: GenerationStoppedPayloadSchema,
};
