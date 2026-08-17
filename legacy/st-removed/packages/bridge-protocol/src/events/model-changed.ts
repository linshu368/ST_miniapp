import { z } from 'zod';
import type { EventMeta } from './types.js';

export const ModelChangedPayloadSchema = z.object({
  model: z.string(),
  provider: z.string(),
});

export const modelChangedMeta: EventMeta = {
  name: 'model:changed',
  payloadSchema: ModelChangedPayloadSchema,
};
