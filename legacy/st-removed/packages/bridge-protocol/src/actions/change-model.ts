import { z } from 'zod';
import type { ActionMeta } from './types.js';

export const ChangeModelPayloadSchema = z.object({
  provider: z.string(),
  modelName: z.string(),
  presetConfigCode: z.enum(['OK', 'ASSIGNMENT_INVALID_FALLBACK', 'NO_ENABLED_DEFAULT']).optional(),
});

export const ChangeModelResultSchema = z.object({
  appliedModel: z.string(),
});

export const changeModelMeta: ActionMeta = {
  name: 'changeModel',
  payloadSchema: ChangeModelPayloadSchema,
  resultSchema: ChangeModelResultSchema,
  requiredPhase: 'ready',
  waitable: true,
};
