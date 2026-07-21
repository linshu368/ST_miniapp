import type { z } from 'zod';
import type { ActionMeta } from './types.js';
import {
  SelectCharacterPayloadSchema,
  SelectCharacterResultSchema,
  selectCharacterMeta,
} from './select-character.js';
import { OpenChatPayloadSchema, OpenChatResultSchema, openChatMeta } from './open-chat.js';
import { NewChatPayloadSchema, NewChatResultSchema, newChatMeta } from './new-chat.js';
import { RenameChatPayloadSchema, RenameChatResultSchema, renameChatMeta } from './rename-chat.js';
import { DeleteChatPayloadSchema, DeleteChatResultSchema, deleteChatMeta } from './delete-chat.js';
import {
  ChangeModelPayloadSchema,
  ChangeModelResultSchema,
  changeModelMeta,
} from './change-model.js';
import {
  SyncModelPresetPayloadSchema,
  SyncModelPresetResultSchema,
  syncModelPresetMeta,
} from './sync-model-preset.js';
import {
  GetReadyStatePayloadSchema,
  GetReadyStateResultSchema,
  getReadyStateMeta,
} from './get-ready-state.js';

export type ActionName =
  | 'selectCharacter'
  | 'openChat'
  | 'newChat'
  | 'renameChat'
  | 'deleteChat'
  | 'changeModel'
  | 'syncModelPreset'
  | 'getReadyState';

export type ActionPayloadMap = {
  selectCharacter: z.infer<typeof SelectCharacterPayloadSchema>;
  openChat: z.infer<typeof OpenChatPayloadSchema>;
  newChat: z.infer<typeof NewChatPayloadSchema>;
  renameChat: z.infer<typeof RenameChatPayloadSchema>;
  deleteChat: z.infer<typeof DeleteChatPayloadSchema>;
  changeModel: z.infer<typeof ChangeModelPayloadSchema>;
  syncModelPreset: z.infer<typeof SyncModelPresetPayloadSchema>;
  getReadyState: z.infer<typeof GetReadyStatePayloadSchema>;
};

export type ActionResultMap = {
  selectCharacter: z.infer<typeof SelectCharacterResultSchema>;
  openChat: z.infer<typeof OpenChatResultSchema>;
  newChat: z.infer<typeof NewChatResultSchema>;
  renameChat: z.infer<typeof RenameChatResultSchema>;
  deleteChat: z.infer<typeof DeleteChatResultSchema>;
  changeModel: z.infer<typeof ChangeModelResultSchema>;
  syncModelPreset: z.infer<typeof SyncModelPresetResultSchema>;
  getReadyState: z.infer<typeof GetReadyStateResultSchema>;
};

export const actionRegistry: Record<ActionName, ActionMeta> = {
  selectCharacter: selectCharacterMeta,
  openChat: openChatMeta,
  newChat: newChatMeta,
  renameChat: renameChatMeta,
  deleteChat: deleteChatMeta,
  changeModel: changeModelMeta,
  syncModelPreset: syncModelPresetMeta,
  getReadyState: getReadyStateMeta,
};
