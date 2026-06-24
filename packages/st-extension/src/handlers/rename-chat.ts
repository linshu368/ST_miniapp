import type { ActionPayloadMap, ActionResultMap } from '@miniapp/bridge-protocol';
import '../st-types.js';

type Payload = ActionPayloadMap['renameChat'];
type Result = ActionResultMap['renameChat'];

export async function handleRenameChat(payload: Payload): Promise<Result> {
  const ctx = SillyTavern.getContext();
  await ctx.renameChat(payload.oldFileName, payload.newName);
  return { newFileName: payload.newName };
}
