/**
 * sync-engine / provisioner / preset-apply.ts
 *
 * 把「当前选中预设」（platform_presets.preset_payload）应用进 oai_settings，
 * 复刻 SillyTavern public/scripts/openai.js `onSettingsPresetChange` 的行为。
 *
 * 为什么需要这一步：
 *   - platform_settings.settings_jsonb.oai_settings.preset_settings_openai 只是「预设下拉框
 *     指针名」（形如 platform_<uuid>）。
 *   - 025_preset_auto_promote 触发器晋升新预设时，只 jsonb_set 这个指针，不写实际采样/prompts 参数。
 *   - 而 ST 启动时 loadOpenAISettings() 直接读 oai_settings，只有用户手动切下拉框才会套用预设文件。
 *   - 因此必须在 provision 下发时，按指针找到对应预设，把 preset_payload 应用进 oai_settings，
 *     否则运营换预设后参数永远不生效（历史事故见 hotfix_apply_0616_to_settings.sql）。
 *
 * 映射来源：ST settingsToUpdate 中 isConnection=false 的全部条目。
 *   - 只有 8 个采样参数是「改名」（temperature→temp_openai 等），其余同名。
 *   - 刻意不含连接/模型类字段（chat_completion_source / custom_url / *_model / reverse_proxy）：
 *     这些由 merger 统一强制覆写（走平台代理 + 档位控制），预设不应干预。
 */

import { cloneDeep } from 'lodash-es';
import { PRESET_TO_OAI_SETTINGS } from '@miniapp/shared';
import type { PresetRow } from './fetcher.js';

export { PRESET_TO_OAI_SETTINGS };

const PRESET_OWNED_OAI_SETTING_KEYS = new Set(Object.values(PRESET_TO_OAI_SETTINGS));

/**
 * 预设控制的字段不可出现在用户 B 段 writable_paths 中。
 *
 * `oai_settings` 整段同样禁止：它会间接允许覆盖 prompts、prompt_order 等预设内容。
 */
export function isPresetOwnedWritablePath(path: string): boolean {
  if (path === 'oai_settings') return true;

  const prefix = 'oai_settings.';
  if (!path.startsWith(prefix)) return false;

  const [oaiKey] = path.slice(prefix.length).split('.', 1);
  return oaiKey !== undefined && PRESET_OWNED_OAI_SETTING_KEYS.has(oaiKey);
}

/** oai_settings.preset_settings_openai 的指针前缀 */
const POINTER_PREFIX = 'platform_';

export interface ApplyPresetResult {
  /** 是否成功把某个预设应用进 oai_settings */
  applied: boolean;
  /** 命中的预设 id（applied=true 时有值；preset_not_found 时也返回解析出的 id 供排查） */
  presetId?: string;
  /** 未应用的原因（便于日志排查） */
  reason?: 'no_pointer' | 'preset_not_found';
}

/**
 * 从指针值（platform_<uuid>）解析出预设 id；格式不符返回 null。
 */
export function resolveActivePresetId(pointer: unknown): string | null {
  if (typeof pointer !== 'string' || !pointer.startsWith(POINTER_PREFIX)) return null;
  const id = pointer.slice(POINTER_PREFIX.length).trim();
  return id || null;
}

/**
 * 按 oai_settings.preset_settings_openai 指针找到对应预设，把其 preset_payload
 * 按 PRESET_TO_OAI_SETTINGS 映射应用进 oai_settings（原地修改传入对象）。
 *
 * - 指针缺失 / 格式不符      → 不应用，reason='no_pointer'
 * - 指针指向的预设不在列表   → 不应用，reason='preset_not_found'（回退到 oai_settings 原值）
 * - 命中                     → 逐键覆盖（仅覆盖 payload 中存在的键），applied=true
 *
 * 值做 cloneDeep，避免与 preset.preset_payload 共享引用。
 */
export function applyActivePreset(
  oaiSettings: Record<string, unknown>,
  presets: PresetRow[]
): ApplyPresetResult {
  const presetId = resolveActivePresetId(oaiSettings.preset_settings_openai);
  if (!presetId) return { applied: false, reason: 'no_pointer' };

  const preset = presets.find((p) => p.id === presetId);
  if (!preset) return { applied: false, presetId, reason: 'preset_not_found' };

  const payload = cloneDeep(preset.preset_payload) as Record<string, unknown>;
  for (const [presetKey, oaiKey] of Object.entries(PRESET_TO_OAI_SETTINGS)) {
    if (payload[presetKey] !== undefined) {
      oaiSettings[oaiKey] = payload[presetKey];
    }
  }

  return { applied: true, presetId };
}
