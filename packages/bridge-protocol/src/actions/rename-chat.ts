import { z } from 'zod';
import type { ActionMeta } from './types.js';

export const RenameChatPayloadSchema = z.object({
  oldFileName: z.string(),
  newName: z.string(),
});

export const RenameChatResultSchema = z.object({
  newFileName: z.string(),
});

export const renameChatMeta: ActionMeta = {
  name: 'renameChat',
  payloadSchema: RenameChatPayloadSchema,
  resultSchema: RenameChatResultSchema,
  requiredPhase: 'ready',
  waitable: true,
};
