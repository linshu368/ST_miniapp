import { z } from 'zod';
import type { ActionMeta } from './types.js';

export const OpenChatPayloadSchema = z.object({
  fileName: z.string(),
  // 历史列表跨角色聚合：openCharacterChat 仅作用于当前角色（this_chid），
  // 故需带上该聊天所属角色 avatar，handler 先切角色再打开。
  avatar: z.string().optional(),
});

export const OpenChatResultSchema = z.object({
  chatId: z.string(),
});

export const openChatMeta: ActionMeta = {
  name: 'openChat',
  payloadSchema: OpenChatPayloadSchema,
  resultSchema: OpenChatResultSchema,
  requiredPhase: 'ready',
  waitable: true,
};
