import { BridgeError } from '@miniapp/bridge-protocol';
import type { ActionPayloadMap, ActionResultMap } from '@miniapp/bridge-protocol';
import '../st-types.js';

type Payload = ActionPayloadMap['deleteChat'];
type Result = ActionResultMap['deleteChat'];

interface ChatListEntry {
  file_name: string;
  [key: string]: unknown;
}

export async function handleDeleteChat(payload: Payload): Promise<Result> {
  const ctx = SillyTavern.getContext();
  const currentChatId = ctx.getCurrentChatId();
  const isCurrentChat = currentChatId === payload.fileName;

  const deleteResp = await fetch('/api/chats/delete', {
    method: 'POST',
    headers: ctx.getRequestHeaders(),
    body: JSON.stringify({
      chatfile: `${payload.fileName}.jsonl`,
      avatar_url: payload.avatar,
    }),
  });

  if (!deleteResp.ok) {
    throw new BridgeError(
      'BRIDGE_EXEC_ST_INTERNAL',
      `Failed to delete chat: ${deleteResp.status} ${deleteResp.statusText}`
    );
  }

  await ctx.eventSource.emit(ctx.eventTypes.CHAT_DELETED, payload.fileName);

  let switchedToChatId: string | null = null;
  if (isCurrentChat) {
    const chatsResp = await fetch('/api/characters/chats', {
      method: 'POST',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify({ avatar_url: payload.avatar }),
    });

    if (chatsResp.ok) {
      const chatsData: unknown = await chatsResp.json();
      const chats = Object.values(chatsData as Record<string, ChatListEntry>);
      if (chats.length > 0) {
        const latest = chats[0]!.file_name.replace('.jsonl', '');
        await ctx.openCharacterChat(latest);
        switchedToChatId = latest;
      }
    }
  }

  return { switchedToChatId };
}
