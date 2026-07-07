import { BridgeError } from '@miniapp/bridge-protocol';
import type { ActionPayloadMap, ActionResultMap } from '@miniapp/bridge-protocol';
import '../st-types.js';
import { preAllowCharacterRegex } from '../patches/regex-autoconfirm.js';
import { preAllowPresetRegex } from '../patches/preset-regex-autoconfirm.js';
import { preSuppressWorldbookAlert } from '../patches/worldbook-autoimport.js';

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

  // 在 selectCharacterById 之前预处理正则 & 世界书：
  // selectCharacterById → getChatResult → printMessages 时 getRegexedString
  // 会用 allowedOnly:true 检查 character_allowed_regex / preset_allowed_regex，提前写入
  // 才能让首次渲染即应用 scoped / preset regex（否则要等 CHAT_CHANGED + reloadCurrentChat）。
  // 同时预设 AlertWI 标记，避免 checkEmbeddedWorld 弹 toastr / 阻塞弹窗。
  const avatar = ctx.characters[index]?.avatar;
  if (avatar) {
    preAllowCharacterRegex(avatar);
    preSuppressWorldbookAlert(avatar);
  }
  // 预设正则不依赖具体角色，独立预授权（当前选中预设含内置正则时才写入）。
  preAllowPresetRegex();

  await ctx.selectCharacterById(index, { switchMenu: false });

  if (payload.forceNewChat) {
    await ctx.executeSlashCommandsWithOptions('/newchat');
  }

  ctx.saveSettingsDebounced();

  return {
    characterId: index,
    chatId: ctx.getCurrentChatId() ?? null,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
