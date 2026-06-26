import { BridgeError } from '@miniapp/bridge-protocol';
import type { ActionPayloadMap, ActionResultMap } from '@miniapp/bridge-protocol';
import '../st-types.js';

type Payload = ActionPayloadMap['openChat'];
type Result = ActionResultMap['openChat'];

export async function handleOpenChat(payload: Payload): Promise<Result> {
  const ctx = SillyTavern.getContext();

  // 历史列表跨角色聚合，而 ST 的 openCharacterChat 仅作用于当前角色（this_chid）。
  // 若该聊天属于其它角色，先切到目标角色再打开，否则会停留在当前对话。
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

  await ctx.openCharacterChat(payload.fileName);
  return { chatId: ctx.getCurrentChatId()! };
}
