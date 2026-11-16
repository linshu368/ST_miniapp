/**
 * backend / features / engine / drive-mode.ts
 *
 * 剧情模式（谁来推动剧情）的读取与渲染。运营配置 drive_mode_options 提供各档规则，
 * 主体模板用 {{DRIVE_RULES}} 标出注入位置，用户偏好 pref_drive_mode 选档。
 */

import {
  DRIVE_MODE_OPTIONS_KEY,
  DriveModesConfigSchema,
  FALLBACK_DRIVE_RULES,
  resolveDriveMode,
  type DriveModesConfig,
} from '@miniapp/shared';
import { observation } from '../../platform/observability/runtime.js';
import type { RuntimeConfigEntry } from '../../platform/runtime-config.js';

export const DRIVE_RULES_PLACEHOLDER = '{{DRIVE_RULES}}';

export function readDriveModes(entries: Map<string, RuntimeConfigEntry>): {
  config: DriveModesConfig | null;
  degraded: boolean;
} {
  const entry = entries.get(DRIVE_MODE_OPTIONS_KEY);
  if (!entry) return { config: null, degraded: false };

  const parsed = DriveModesConfigSchema.safeParse(entry.value);
  if (parsed.success) return { config: parsed.data, degraded: false };

  // Validation issues can contain operator rule text; log only the config identity/version.
  observation.emit(
    'engine.drive_modes_degraded',
    'engine.config',
    {
      outcome: 'degraded',
      outcome_known: false,
      resource: DRIVE_MODE_OPTIONS_KEY,
      config_version: entry.version,
    },
    'warn'
  );
  return { config: null, degraded: true };
}

/**
 * 模式已配置但模板里没有占位符时，用户的选择不会生效。这正是回复风格曾经静默失效的形态，
 * 所以每次配置版本变化时都要显式告警，而不是悄悄跑下去。
 */
export function warnIfDriveSlotMissing(
  template: string,
  config: DriveModesConfig | null,
  templateVersion: number | undefined
): boolean {
  if (!config || template.includes(DRIVE_RULES_PLACEHOLDER)) return false;
  observation.emit(
    'engine.drive_slot_missing',
    'engine.config',
    {
      outcome: 'degraded',
      outcome_known: false,
      resource: DRIVE_MODE_OPTIONS_KEY,
      config_version: templateVersion,
    },
    'warn'
  );
  return true;
}

/** 生成时按当前偏好取档；重新生成同样使用当前选择。 */
export function selectDriveRules(
  config: DriveModesConfig | null,
  preferredId: string | undefined
): { modeId: string | null; rules: string } {
  if (!config) return { modeId: null, rules: FALLBACK_DRIVE_RULES };
  const mode = resolveDriveMode(preferredId, config);
  return { modeId: mode.id, rules: mode.rules };
}
