/**
 * st-extension / patches / llm-metadata-inject.ts
 *
 * 在每次 LLM 请求发出前，通过 ST 原生 custom_include_headers 机制
 * 注入 X-ST-Character-Id 和 X-ST-Preset-Id header，
 * 使 llm-proxy 能将 character_id / preset_id 落入 chat_history 表。
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

function onSettingsReady(generateData: Record<string, unknown>): void {
  const characterId = extractCharacterUuid();
  const presetId = extractPresetUuid();

  if (!characterId && !presetId) return;

  const lines: string[] = [];
  if (characterId) lines.push(`X-ST-Character-Id: ${characterId}`);
  if (presetId) lines.push(`X-ST-Preset-Id: ${presetId}`);

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
