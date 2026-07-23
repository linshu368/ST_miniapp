import { z } from 'zod';
import type { ActionMeta } from './types.js';

export const SelectCharacterPayloadSchema = z.object({
  avatar: z.string(),
  forceNewChat: z.boolean().optional(),
  skipChatLoad: z.boolean().optional(),
});

export const SelectCharacterResultSchema = z.object({
  characterId: z.number(),
  chatId: z.string().nullable(),
});

export const selectCharacterMeta: ActionMeta = {
  name: 'selectCharacter',
  payloadSchema: SelectCharacterPayloadSchema,
  resultSchema: SelectCharacterResultSchema,
  // interactive：ST 端 settings/角色列表/tokenizers/persona/world-info 就绪即可安全执行，
  // 不必等 APP_READY——压缩快速点卡用户的闸门等待（慢 boot 长尾上 interactive 领先 ready 数秒）。
  requiredPhase: 'interactive',
  waitable: true,
};
