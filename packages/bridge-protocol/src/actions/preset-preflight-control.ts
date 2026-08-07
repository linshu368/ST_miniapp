import { z } from 'zod';
import type { ActionMeta } from './types.js';

export const PresetPreflightControlPayloadSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('set-ready'),
    ready: z.boolean(),
  }),
  z.object({
    operation: z.literal('complete'),
    requestId: z.string().trim().min(1).max(64),
    outcome: z.enum(['unchanged', 'synced', 'failed']),
  }),
]);

export const PresetPreflightControlResultSchema = z.object({
  accepted: z.boolean(),
});

export const presetPreflightControlMeta: ActionMeta = {
  name: 'presetPreflightControl',
  payloadSchema: PresetPreflightControlPayloadSchema,
  resultSchema: PresetPreflightControlResultSchema,
  requiredPhase: 'ready',
  waitable: true,
};
