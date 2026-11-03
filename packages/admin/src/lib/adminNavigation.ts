import {
  IMAGE_GENERATION_CONFIG_KEYS,
  IMAGE_PLAZA_CONFIG_KEYS,
  INVITE_PROGRAM_CONFIG_KEYS,
  managedConfigKeys,
  PLATFORM_INSTRUCTION_CONFIG_KEYS,
  type ImageGenerationConfigKey,
  type ImagePlazaConfigKey,
  type InviteProgramConfigKey,
  type ManagedConfigKey,
  type PlatformInstructionConfigKey,
} from '@miniapp/admin-client';
import {
  CREATOR_REVIEW_PROMPT_KEY,
  VIP_STRATEGY_CONFIG_KEYS,
  type VipStrategyConfigKey,
} from '@miniapp/shared';

export type AdminViewKey =
  | 'configs'
  | 'fallback_config'
  | 'outreach_credit_grant'
  | 'invite_program'
  | 'image_generation_config'
  | 'image_plaza'
  | 'platform_instructions'
  | 'reply_style_options'
  | 'vip_strategy'
  | 'text_postprocess'
  | 'characters'
  | 'announcements'
  | 'releases';

export { VIP_STRATEGY_CONFIG_KEYS, type VipStrategyConfigKey };

export {
  IMAGE_GENERATION_CONFIG_KEYS,
  IMAGE_PLAZA_CONFIG_KEYS,
  INVITE_PROGRAM_CONFIG_KEYS,
  PLATFORM_INSTRUCTION_CONFIG_KEYS,
  type ImageGenerationConfigKey,
  type ImagePlazaConfigKey,
  type InviteProgramConfigKey,
  type PlatformInstructionConfigKey,
};

/** 「裂变邀请管理」的 tab：三个配置加末位固定的「邀请数据」。 */
export type InviteProgramTabKey = InviteProgramConfigKey | 'records';

export function isImagePlazaConfigKey(key: ManagedConfigKey): key is ImagePlazaConfigKey {
  return (IMAGE_PLAZA_CONFIG_KEYS as readonly string[]).includes(key);
}

export function isPlatformInstructionConfigKey(
  key: ManagedConfigKey
): key is PlatformInstructionConfigKey {
  return (PLATFORM_INSTRUCTION_CONFIG_KEYS as readonly string[]).includes(key);
}

export function isImageGenerationConfigKey(key: ManagedConfigKey): key is ImageGenerationConfigKey {
  return (IMAGE_GENERATION_CONFIG_KEYS as readonly string[]).includes(key);
}

/** 旧的单一免费次数键。额度改由 VIP 策略的 feature_free_trial_limits 发布，不再给运营入口。 */
const LEGACY_MEDIA_FREE_TRIAL_LIMIT_KEY = 'media_feature_free_trial_limit';

export function isInviteProgramConfigKey(key: ManagedConfigKey): key is InviteProgramConfigKey {
  return (INVITE_PROGRAM_CONFIG_KEYS as readonly string[]).includes(key);
}

export function isVipStrategyConfigKey(key: ManagedConfigKey): key is VipStrategyConfigKey {
  return (VIP_STRATEGY_CONFIG_KEYS as readonly string[]).includes(key);
}

/** 侧栏「运营配置」子菜单实际展示的 config 目录（invite 三项已收进「裂变邀请管理」）。 */
export const sidebarManagedConfigKeys: readonly ManagedConfigKey[] = managedConfigKeys.filter(
  (key) =>
    !isInviteProgramConfigKey(key) &&
    !isImageGenerationConfigKey(key) &&
    !isImagePlazaConfigKey(key) &&
    !isPlatformInstructionConfigKey(key) &&
    key !== 'reply_style_options' &&
    key !== CREATOR_REVIEW_PROMPT_KEY &&
    !isVipStrategyConfigKey(key) &&
    key !== LEGACY_MEDIA_FREE_TRIAL_LIMIT_KEY
);

const CONFIG_PREFIX = 'config:';

export function configMenuKey(key: ManagedConfigKey): string {
  return `${CONFIG_PREFIX}${key}`;
}

export function resolveAdminMenuSelection(key: string): {
  view: AdminViewKey;
  configKey?: ManagedConfigKey;
} {
  if (key === 'reply_style_options')
    return { view: 'reply_style_options', configKey: 'reply_style_options' };
  if (key === 'fallback_config') return { view: 'fallback_config', configKey: 'llm_model_catalog' };
  if (key.startsWith(CONFIG_PREFIX)) {
    const configKey = key.slice(CONFIG_PREFIX.length) as ManagedConfigKey;
    if (managedConfigKeys.includes(configKey)) {
      if (configKey === 'reply_style_options') return { view: 'reply_style_options', configKey };
      // invite 三个 config 的编辑入口在「裂变邀请管理」的 tab 里，不再落到通用 configs 视图
      if (isInviteProgramConfigKey(configKey)) return { view: 'invite_program', configKey };
      if (isImageGenerationConfigKey(configKey)) {
        return { view: 'image_generation_config', configKey };
      }
      if (isImagePlazaConfigKey(configKey)) return { view: 'image_plaza', configKey };
      if (isPlatformInstructionConfigKey(configKey)) {
        return { view: 'platform_instructions', configKey };
      }
      if (isVipStrategyConfigKey(configKey)) return { view: 'vip_strategy', configKey };
      return { view: 'configs', configKey };
    }
  }
  if (
    key === 'outreach_credit_grant' ||
    key === 'invite_program' ||
    key === 'image_generation_config' ||
    key === 'image_plaza' ||
    key === 'platform_instructions' ||
    key === 'vip_strategy' ||
    key === 'text_postprocess' ||
    key === 'characters' ||
    key === 'announcements' ||
    key === 'releases'
  ) {
    return { view: key };
  }
  return { view: 'configs' };
}
