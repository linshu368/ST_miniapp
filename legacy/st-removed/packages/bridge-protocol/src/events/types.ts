import type { z } from 'zod';

export interface EventMeta {
  name: string;
  payloadSchema: z.ZodType;
}
