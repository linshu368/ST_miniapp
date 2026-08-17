import { z } from 'zod';
import type { EventMeta } from './types.js';

export const SettingsUpdatedPayloadSchema = z.object({});

export const settingsUpdatedMeta: EventMeta = {
  name: 'settings:updated',
  payloadSchema: SettingsUpdatedPayloadSchema,
};
