import { z } from 'zod';
import type { ActionMeta } from './types.js';

export const ChangeModelPayloadSchema = z.object({
  provider: z.string(),
  modelName: z.string(),
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
