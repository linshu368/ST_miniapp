import type { ActionResultMap } from '@miniapp/bridge-protocol';
import '../st-types.js';

type Result = ActionResultMap['newChat'];

export async function handleNewChat(): Promise<Result> {
  const ctx = SillyTavern.getContext();
  await ctx.executeSlashCommandsWithOptions('/newchat');
  return { chatId: ctx.getCurrentChatId()! };
}
