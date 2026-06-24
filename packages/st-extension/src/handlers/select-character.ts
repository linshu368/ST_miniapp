import { BridgeError } from '@miniapp/bridge-protocol';
import type { ActionPayloadMap, ActionResultMap } from '@miniapp/bridge-protocol';
import '../st-types.js';

type Payload = ActionPayloadMap['selectCharacter'];
type Result = ActionResultMap['selectCharacter'];

export async function handleSelectCharacter(payload: Payload): Promise<Result> {
  const ctx = SillyTavern.getContext();
  const index = ctx.characters.findIndex((c) => c.avatar === payload.avatar);
  if (index < 0) {
    throw new BridgeError(
      'BRIDGE_EXEC_PRECONDITION_FAILED',
      `Character not found: ${payload.avatar}`
    );
  }

  await ctx.selectCharacterById(index, { switchMenu: false });
  ctx.saveSettingsDebounced();

  return {
    characterId: index,
    chatId: ctx.getCurrentChatId() ?? null,
  };
}
