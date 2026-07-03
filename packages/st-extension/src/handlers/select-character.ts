import { BridgeError } from '@miniapp/bridge-protocol';
import type { ActionPayloadMap, ActionResultMap } from '@miniapp/bridge-protocol';
import '../st-types.js';

type Payload = ActionPayloadMap['selectCharacter'];
type Result = ActionResultMap['selectCharacter'];

export async function handleSelectCharacter(payload: Payload): Promise<Result> {
  const ctx = SillyTavern.getContext();

  let index = ctx.characters.findIndex((c) => c.avatar === payload.avatar);

  // 懒下发：目标卡可能刚由平台按需下发到磁盘，ST 内存角色列表尚未刷新。
  // 未命中时重载角色列表（getCharacters 会让服务端重扫目录）并有界重试，
  // 覆盖「PNG 刚落盘、列表未刷新」的竞态。
  if (index < 0) {
    for (let attempt = 0; attempt < 3 && index < 0; attempt++) {
      await ctx.getCharacters();
      index = ctx.characters.findIndex((c) => c.avatar === payload.avatar);
      if (index < 0) await delay(300);
    }
  }

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
