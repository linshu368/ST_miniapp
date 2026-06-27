import { BridgeError } from '@miniapp/bridge-protocol';
import type { ActionPayloadMap, ActionResultMap } from '@miniapp/bridge-protocol';
import '../st-types.js';

type Payload = ActionPayloadMap['renameChat'];
type Result = ActionResultMap['renameChat'];

export async function handleRenameChat(payload: Payload): Promise<Result> {
  const ctx = SillyTavern.getContext();

  // renameChat 作用于当前角色（this_chid）。跨角色重命名需先切到该角色。
  if (payload.avatar) {
    const currentAvatar = ctx.characters[ctx.characterId ?? -1]?.avatar;
    if (payload.avatar !== currentAvatar) {
      const index = ctx.characters.findIndex((c) => c.avatar === payload.avatar);
      if (index < 0) {
        throw new BridgeError(
          'BRIDGE_EXEC_PRECONDITION_FAILED',
          `Character not found for chat: ${payload.avatar}`
        );
      }
      await ctx.selectCharacterById(index, { switchMenu: false });
    }
  }

  await ctx.renameChat(payload.oldFileName, payload.newName);
  return { newFileName: payload.newName };
}
