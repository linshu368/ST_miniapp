import { z } from 'zod';
import type { EventMeta } from './types.js';

export const BillingInsufficientPayloadSchema = z.object({
  creditsRequired: z.number().nonnegative(),
  creditsAvailable: z.number().nonnegative(),
});

export const billingInsufficientMeta: EventMeta = {
  name: 'billing:insufficient',
  payloadSchema: BillingInsufficientPayloadSchema,
};
