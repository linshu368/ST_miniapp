/**
 * st-extension / patches / llm-metadata-inject.ts
 *
 * 在每次 LLM 请求发出前，通过 ST 原生 custom_include_headers 机制
 * 注入 X-ST-Character-Id / X-ST-Preset-Id / X-ST-User-Input header，
 * 使 llm-proxy 能将 character_id / preset_id / user_input 落入 chat_history 表。
 *
 * 为什么 user_input 要在这里注入而不是 backend 从 messages 提取：
 *   backend 收到的 messages 数组是「预设组装 + 深度注入 + post-history 指令 + strict
 *   post-processing」后的产物，最后一条 role=user 往往是防截断/越狱等注入指令，
 *   且真实输入也被模板前后缀包裹。用户真正打的原文只在 ST 客户端侧的 chat 日志里
 *   （ctx.chat 最后一条 is_user 的 .mes）才是干净的，故在此捕获、经 header 透传给
 *   backend 单一写入点，backend 用它覆盖从 messages 提取的值。
 *
 * 利用 CHAT_COMPLETION_SETTINGS_READY 事件：该事件在 generate_data 构建完毕、
 * fetch 发出之前触发，传入 generate_data 引用可原地修改。
 * ST server CUSTOM source 路径会 mergeObjectWithYaml(headers, custom_include_headers)
 * 并在上游 fetch 中展开，因此 header 能透传到 llm-proxy。
 */

import '../st-types.js';

const AVATAR_UUID_RE =
  /^platform_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.png$/i;
const POINTER_PREFIX = 'platform_';

// HTTP header 值不能带原始换行、非 ASCII 需编码，故对原始输入做 UTF-8 → base64。
// 同时限制长度：极长输入（大段粘贴）若整条塞进 header 可能超出 Node/代理的 header
// 缓冲上限而使「整个 LLM 请求」失败——那会连聊天都发不出，比日志不准严重得多。
// 因此超限即截断（审计日志可接受），保证请求本身永不因 header 过大而挂。
const MAX_RAW_INPUT_CHARS = 4000;

function extractCharacterUuid(): string | null {
  try {
    const ctx = SillyTavern.getContext();
    if (ctx.characterId == null) return null;
    const avatar = ctx.characters[ctx.characterId]?.avatar;
    if (typeof avatar !== 'string') return null;
    const match = avatar.match(AVATAR_UUID_RE);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function extractPresetUuid(): string | null {
  try {
    const ctx = SillyTavern.getContext();
    const pointer = ctx.chatCompletionSettings.preset_settings_openai as string | undefined;
    if (typeof pointer !== 'string' || !pointer.startsWith(POINTER_PREFIX)) return null;
    const id = pointer.slice(POINTER_PREFIX.length).trim();
    return id || null;
  } catch {
    return null;
  }
}

/**
 * 从 ST 客户端聊天日志中取「本轮真实用户输入」：ctx.chat 里最后一条 is_user 的原文。
 * ctx.chat 存的是用户实际打的内容，不含预设/世界书/深度注入等组装产物，
 * 因此这里拿到的才是干净的原始输入。
 */
function extractRawUserInput(): string | null {
  try {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat;
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
      const entry = chat[i] as { is_user?: boolean; is_system?: boolean; mes?: unknown };
      if (entry?.is_user === true && entry.is_system !== true && typeof entry.mes === 'string') {
        const mes = entry.mes.trim();
        return mes.length > 0 ? mes : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** UTF-8 → base64，供 header 传输（浏览器 btoa 只吃 latin1，需先转字节）。 */
function encodeHeaderValue(text: string): string {
  const clipped = text.length > MAX_RAW_INPUT_CHARS ? text.slice(0, MAX_RAW_INPUT_CHARS) : text;
  const bytes = new TextEncoder().encode(clipped);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function onSettingsReady(generateData: Record<string, unknown>): void {
  const characterId = extractCharacterUuid();
  const presetId = extractPresetUuid();
  const rawUserInput = extractRawUserInput();

  const lines: string[] = [];
  if (characterId) lines.push(`X-ST-Character-Id: ${characterId}`);
  if (presetId) lines.push(`X-ST-Preset-Id: ${presetId}`);
  if (rawUserInput) lines.push(`X-ST-User-Input: ${encodeHeaderValue(rawUserInput)}`);

  if (lines.length === 0) return;

  const existing =
    typeof generateData.custom_include_headers === 'string'
      ? generateData.custom_include_headers.trim()
      : '';

  generateData.custom_include_headers = existing
    ? `${existing}\n${lines.join('\n')}`
    : lines.join('\n');
}

export function installLlmMetadataInject(): void {
  const ctx = SillyTavern.getContext();
  ctx.eventSource.on(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);
}
