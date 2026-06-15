/**
 * sync-engine / provisioner / merger.ts
 *
 * merge(A_settings, B_settings) 逻辑 + character_ref 有效性校验。
 *
 * 核心原则：
 *   - 所有逻辑在内存中完成，不做任何 IO（writer.ts 负责写盘）
 *   - B 只能覆盖 writable_paths 白名单内的键（决策 1）
 *   - character_ref 失效时回退到默认卡（决策 8）
 */

import { get as lodashGet, set as lodashSet, cloneDeep } from 'lodash-es';
import type { CharacterRow, PlatformSettingsRow, UserSettingsRow } from './fetcher.js';

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/** merge 后的 settings，附带一个 debug 标记字段 */
export interface MergedSettings {
  /** 最终写入 settings.json 的内容 */
  settings: Record<string, unknown>;
  /** 本次 merge 是否触发了 character_ref 失效兜底 */
  hadInvalidRef: boolean;
  /** 如果触发了兜底，记录原来的失效值 */
  invalidRefValue?: string;
}

// ─── 主 merge 函数 ────────────────────────────────────────────────────────────
/**
 * 将平台 settings（A）与用户 settings 镜像（B）合并，
 * 并对 character_ref 类型的字段做有效性校验。
 *
 * @param platformSettings - 分区 A 最新版本
 * @param userSettings     - 分区 B 该用户最新行（null 表示新用户，完全用 A 默认值）
 * @param availableCharIds - 本次已下发的角色卡 id 列表（用于 character_ref 校验）
 * @param defaultCharacter - is_default=true 的卡（character_ref 失效时的兜底）
 */
export function mergeSettings(
  platformSettings: PlatformSettingsRow,
  userSettings: UserSettingsRow | null,
  availableCharIds: string[],
  defaultCharacter: CharacterRow | undefined
): MergedSettings {
  // 深拷贝 A 作为 base（绝不修改原始对象）
  const merged = cloneDeep(platformSettings.settings_jsonb) as Record<string, unknown>;

  // 如果有 B 类记录，按白名单覆盖
  if (userSettings) {
    for (const { path, transform } of platformSettings.writable_paths) {
      const bVal = lodashGet(userSettings.settings_jsonb, path);
      if (bVal !== undefined) {
        // character_ref 在投影阶段做校验（这里先 set，后面统一校验）
        // passthrough 直接覆盖
        lodashSet(merged, path, bVal);
      }
    }
  }

  // character_ref 有效性校验（决策 8）
  // 在已 merge 的结果上对所有 character_ref 类型的路径做校验
  let hadInvalidRef = false;
  let invalidRefValue: string | undefined;

  for (const { path, transform } of platformSettings.writable_paths) {
    if (transform !== 'character_ref') continue;

    const currentVal = lodashGet(merged, path) as string | undefined;
    if (!currentVal) continue;

    // currentVal 格式：platform_<uuid>.png
    // 从中提取 uuid 部分做校验
    const match = currentVal.match(/^platform_([0-9a-f-]+)\.png$/i);
    if (!match) {
      // 格式不符合 platform_<uuid>.png，视为失效
      hadInvalidRef = true;
      invalidRefValue = currentVal;
      const fallback = buildFallbackCharRef(defaultCharacter);
      if (fallback) lodashSet(merged, path, fallback);
      continue;
    }

    const refId = match[1] ?? '';
    if (!refId || !availableCharIds.includes(refId)) {
      // 指向的卡 uuid 不在本次已下发列表中，视为失效
      hadInvalidRef = true;
      invalidRefValue = currentVal;
      const fallback = buildFallbackCharRef(defaultCharacter);
      if (fallback) lodashSet(merged, path, fallback);
    }
  }

  return { settings: merged, hadInvalidRef, invalidRefValue };
}

/** 构造兜底的 character_ref 值（platform_<default_uuid>.png） */
function buildFallbackCharRef(defaultCharacter: CharacterRow | undefined): string | undefined {
  if (!defaultCharacter) return undefined;
  return `platform_${defaultCharacter.id}.png`;
}
