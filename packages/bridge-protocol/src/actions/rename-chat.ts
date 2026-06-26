import { z } from 'zod';
import type { ActionMeta } from './types.js';

export const RenameChatPayloadSchema = z.object({
  oldFileName: z.string(),
  newName: z.string(),
  // renameChat 同样作用于当前角色（this_chid），跨角色重命名需先切到该角色。
  avatar: z.string().optional(),
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
