import type { ActionPayloadMap, ActionResultMap } from '@miniapp/bridge-protocol';
import '../st-types.js';

type Payload = ActionPayloadMap['openChat'];
type Result = ActionResultMap['openChat'];

export async function handleOpenChat(payload: Payload): Promise<Result> {
  const ctx = SillyTavern.getContext();
  await ctx.openCharacterChat(payload.fileName);
  return { chatId: ctx.getCurrentChatId()! };
}
