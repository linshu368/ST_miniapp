import { z } from 'zod';
import type { EventMeta } from './types.js';

export const AppReadyPayloadSchema = z.object({});

export const appReadyMeta: EventMeta = {
  name: 'app:ready',
  payloadSchema: AppReadyPayloadSchema,
};
