import { BridgeError } from '@miniapp/bridge-protocol';
import type { ActionPayloadMap, ActionResultMap } from '@miniapp/bridge-protocol';
import '../st-types.js';
import type { STCharacter, STContext } from '../st-types.js';
import { preAllowCharacterRegex } from '../patches/regex-autoconfirm.js';
import { preAllowPresetRegex } from '../patches/preset-regex-autoconfirm.js';
import { preSuppressWorldbookAlert } from '../patches/worldbook-autoimport.js';
import { stTiming } from '../debug-timing.js'; // [iframe-timing] TEMP DEBUG
// [iframe-timing] TEMP DEBUG: 点卡窗口细粒度探针（资源瀑布 + 事件序列 + 长任务）
import { startSelectProbe, markSelectProbe, stopSelectProbe } from '../debug-select-probes.js';

type Payload = ActionPayloadMap['selectCharacter'];
type Result = ActionResultMap['selectCharacter'];

export async function handleSelectCharacter(payload: Payload): Promise<Result> {
  stTiming('sel_start'); // [iframe-timing] TEMP DEBUG
  startSelectProbe(); // [iframe-timing] TEMP DEBUG
  const ctx = SillyTavern.getContext();

  let index = ctx.characters.findIndex((c) => c.avatar === payload.avatar);

  // 懒下发：目标卡可能刚由平台按需下发到磁盘，ST 内存角色列表尚未包含它。
  // 优先「单卡增量注入」：走 ST 原生单卡端点 /api/characters/get（lazy 模式下
  // unshallowCharacter 用的同一端点）拉全量数据 push 进内存列表 —— 1 次单卡请求
  // 替代原来的全量 getCharacters() 重扫（服务端重扫目录 + 缩略图，实测 2~3.5s，
  // 即 H1 峰值来源）。
  let reloadAttempts = 0; // [iframe-timing] TEMP DEBUG
  let injected = false; // [iframe-timing] TEMP DEBUG
  const foundInMemory = index >= 0; // [iframe-timing] TEMP DEBUG
  if (index < 0) {
    index = await fetchAndInjectCharacter(ctx, payload.avatar);
    injected = index >= 0;
  }

  // 兜底：注入失败（服务端瞬时错误等）退回全量重载 + 有界重试，保持旧行为。
  if (index < 0) {
    for (let attempt = 0; attempt < 3 && index < 0; attempt++) {
      reloadAttempts++;
      await ctx.getCharacters();
      index = ctx.characters.findIndex((c) => c.avatar === payload.avatar);
      if (index < 0) await delay(300);
    }
  }
  // [iframe-timing] TEMP DEBUG: H1 —— 找卡 + 注入（或全量重载）耗时
  stTiming(
    'sel_reload_done',
    `foundInMemory=${foundInMemory},injected=${injected},reloadAttempts=${reloadAttempts}`
  );
  markSelectProbe('h1_done'); // [iframe-timing] TEMP DEBUG

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

  await ctx.selectCharacterById(index, {
    switchMenu: false,
    // forceNewChat 路径无需先拉取、渲染旧聊天；doNewChat 会直接创建并加载新文件。
    skipChatLoad: payload.forceNewChat,
  });
  stTiming('sel_selectById_done'); // [iframe-timing] TEMP DEBUG: H3
  markSelectProbe('h3_done'); // [iframe-timing] TEMP DEBUG

  if (payload.forceNewChat) {
    // 直接调用 ST 原生函数，跳过 slash 解析；平台不会恢复角色 chat 指针，
    // 因此无需把本次临时文件名再次写回角色 PNG。
    await ctx.doNewChat({ skipCharacterSave: true });
  }
  stTiming(
    'sel_newchat_done',
    `forceNewChat=${!!payload.forceNewChat},fastNewChat=${!!payload.forceNewChat}`
  ); // [iframe-timing] TEMP DEBUG: H2
  stopSelectProbe(); // [iframe-timing] TEMP DEBUG: 收割点卡窗口瀑布/事件/长任务并上报

  ctx.saveSettingsDebounced();

  return {
    characterId: index,
    chatId: ctx.getCurrentChatId() ?? null,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 单卡增量注入：从 ST 原生 /api/characters/get 拉目标卡全量数据，追加进
 * ctx.characters 尾部（不打乱既有 index，this_chid 语义安全），返回新 index。
 *
 * 说明：
 * - 端点返回 processCharacter(shallow:false) 的全量卡（服务端只读这一个 PNG），
 *   与 lazy 模式下 unshallowCharacter 补拉后的列表项形状一致；
 * - 复刻 vendor getCharacters() 对单项的规范化（chat 字段兜底 + String 化，
 *   见 script.js getCharacters）。不做 DOMPurify（平台卡为运营可信内容，且
 *   注入项后续渲染路径与原生一致）；
 * - PNG 刚落盘的竞态：ensureCharacter 返回即已写盘，正常一次命中；404 等
 *   瞬时失败时小步重试 2 次，仍失败返回 -1 交由调用方全量重载兜底。
 */
async function fetchAndInjectCharacter(ctx: STContext, avatar: string): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('/api/characters/get', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatar }),
      });
      if (res.ok) {
        const data = (await res.json()) as STCharacter;
        if (!data || data.avatar !== avatar) return -1;
        if (!data.chat) data.chat = `${data.name} - ${humanizedDateTime()}`;
        data.chat = String(data.chat);
        // 并发防重：等待期间列表可能已被其他路径刷新（如全量 getCharacters）
        const existing = ctx.characters.findIndex((c) => c.avatar === avatar);
        if (existing >= 0) {
          ctx.characters[existing] = data;
          return existing;
        }
        ctx.characters.push(data);
        return ctx.characters.length - 1;
      }
    } catch {
      /* 网络瞬时失败，走下方重试 */
    }
    await delay(300);
  }
  return -1;
}

/** 复刻 vendor RossAscends-mods.js humanizedDateTime 的 chat 文件名时间戳格式。 */
function humanizedDateTime(): string {
  const date = new Date();
  const pad = (n: number, len = 2) => n.toString().padStart(len, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `@${pad(date.getHours())}h${pad(date.getMinutes())}m${pad(date.getSeconds())}s` +
    `${pad(date.getMilliseconds(), 3)}ms`
  );
}
