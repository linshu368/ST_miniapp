import { z } from 'zod';
import type { EventMeta } from './types.js';

export const PresetPreflightRequestedPayloadSchema = z.object({
  requestId: z.string().trim().min(1).max(64),
  currentModel: z.string().nullable(),
  currentPresetPointer: z.string().nullable(),
});

export const presetPreflightRequestedMeta: EventMeta = {
  name: 'preset:preflight-requested',
  payloadSchema: PresetPreflightRequestedPayloadSchema,
};
