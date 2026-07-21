import { z } from 'zod';
import type { ActionMeta } from './types.js';

export const SyncModelPresetPayloadSchema = z.object({
  syncId: z.string().trim().min(1).max(64),
  modelName: z.string().trim().min(1).max(200),
  presetId: z.string().uuid(),
  presetPointer: z.string().regex(/^platform_[0-9a-fA-F-]{36}$/),
  assignmentsVersion: z.number().int().nonnegative(),
  chunkIndex: z.number().int().nonnegative(),
  chunkCount: z.number().int().min(1).max(128),
  chunk: z.string().max(24_000),
});

export const SyncModelPresetResultSchema = z.object({
  complete: z.boolean(),
  appliedModel: z.string().nullable(),
  appliedPresetId: z.string().uuid().nullable(),
});

export const syncModelPresetMeta: ActionMeta = {
  name: 'syncModelPreset',
  payloadSchema: SyncModelPresetPayloadSchema,
  resultSchema: SyncModelPresetResultSchema,
  requiredPhase: 'ready',
  waitable: true,
};
