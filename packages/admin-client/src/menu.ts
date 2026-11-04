import { CREATOR_REVIEW_PROMPT_KEY, VIP_STRATEGY_CONFIG_KEYS } from '@miniapp/shared';
import type { ManagedConfigKey } from './configSchemas';

/**
 * 运营平台菜单分组。网页侧栏和 CLI 的 `config list` 共用这一份，保证两边说的“在哪一组”一致。
 * 页面内容不在这里定义；这里只描述菜单结构和每个入口管理哪些 managed config。
 */

export const INVITE_PROGRAM_CONFIG_KEYS = [
  'miniapp_invite_reward_rules',
  'miniapp_invite_center_config',
  'miniapp_invite_entry_enabled',
] as const satisfies readonly ManagedConfigKey[];
export type InviteProgramConfigKey = (typeof INVITE_PROGRAM_CONFIG_KEYS)[number];

export const IMAGE_GENERATION_CONFIG_KEYS = [
  'image_generation_enabled',
  'image_generation_credits',
  'image_price_label',
  'image_text_model_config',
  'image_prompt_policy',
  'image_default_art_style',
  'image_description_system_prompt',
  'image_width',
  'image_height',
  'image_max_prompt_chars',
  'image_max_output_bytes',
  'image_prompt_over_limit_hint',
  'image_description_failed_hint',
  'image_generation_failed_hint',
  'image_failed_unknown_hint',
] as const satisfies readonly ManagedConfigKey[];
export type ImageGenerationConfigKey = (typeof IMAGE_GENERATION_CONFIG_KEYS)[number];

export const IMAGE_PLAZA_CONFIG_KEYS = [
  'image_plaza_model_catalog',
  'image_plaza_share_tip',
  'image_plaza_tags',
] as const satisfies readonly ManagedConfigKey[];
export type ImagePlazaConfigKey = (typeof IMAGE_PLAZA_CONFIG_KEYS)[number];

/** One workspace, four independently versioned managed-config keys. */
export const PLATFORM_INSTRUCTION_CONFIG_KEYS = [
  'choice_rules',
  'status_rules',
  'memory_rules',
  'system_instructions',
] as const satisfies readonly ManagedConfigKey[];
export type PlatformInstructionConfigKey = (typeof PLATFORM_INSTRUCTION_CONFIG_KEYS)[number];

/** 不是“单个配置一页”的专用页面。 */
export type AdminMenuViewId =
  | 'fallback_config'
  | 'platform_instructions'
  | 'reply_style_options'
  | 'text_postprocess'
  | 'characters'
  | 'vip_strategy'
  | 'invite_program'
  | 'announcements'
  | 'image_generation_config'
  | 'image_plaza';

export type AdminMenuItem =
  /** 通用配置页：一个 key 一页，名称默认取配置注册表的中文名。 */
  | { kind: 'config'; key: ManagedConfigKey; label?: string }
  /** 专用页面：configKeys 是该页面会发布的 managed config（可为空，如角色卡、公告）。 */
  | {
      kind: 'view';
      view: AdminMenuViewId;
      label: string;
      configKeys: readonly ManagedConfigKey[];
    };

export interface AdminMenuGroup {
  id: string;
  label: string;
  items: readonly AdminMenuItem[];
}

export const ADMIN_MENU_GROUPS: readonly AdminMenuGroup[] = [
  {
    id: 'models',
    label: '模型与计费',
    items: [
      { kind: 'config', key: 'llm_model_catalog' },
      {
        kind: 'view',
        view: 'fallback_config',
        label: '兜底配置',
        configKeys: ['llm_model_catalog'],
      },
      { kind: 'config', key: 'llm_provider_routing_config' },
      { kind: 'config', key: 'llm_pricing_config' },
    ],
  },
  {
    id: 'dialogue',
    label: '对话与回复',
    items: [
      {
        kind: 'view',
        view: 'platform_instructions',
        label: '主体与模块规则',
        configKeys: PLATFORM_INSTRUCTION_CONFIG_KEYS,
      },
      {
        kind: 'view',
        view: 'reply_style_options',
        label: '回复风格',
        configKeys: ['reply_style_options'],
      },
      { kind: 'config', key: 'pref_word_count_tiers' },
      { kind: 'view', view: 'text_postprocess', label: '回复富文本规则', configKeys: [] },
    ],
  },
  {
    id: 'characters',
    label: '角色与大厅',
    items: [
      { kind: 'view', view: 'characters', label: '角色卡', configKeys: [] },
      { kind: 'config', key: CREATOR_REVIEW_PROMPT_KEY, label: '角色卡审核' },
      { kind: 'config', key: 'lobby_ranking_params' },
    ],
  },
  {
    id: 'monetization',
    label: '充值与会员',
    items: [
      { kind: 'config', key: 'miniapp_payment_plans' },
      {
        kind: 'view',
        view: 'vip_strategy',
        label: 'VIP 策略',
        configKeys: VIP_STRATEGY_CONFIG_KEYS,
      },
      { kind: 'config', key: 'miniapp_character_free_chat_quota_limit' },
      { kind: 'config', key: 'miniapp_free_quota_exhausted_dialog_config' },
    ],
  },
  {
    id: 'growth',
    label: '用户增长',
    items: [
      { kind: 'config', key: 'miniapp_new_user_signup_bonus_credits' },
      { kind: 'config', key: 'miniapp_checkin_new_user_credits' },
      { kind: 'config', key: 'miniapp_checkin_veteran_credits' },
      {
        kind: 'view',
        view: 'invite_program',
        label: '裂变邀请管理',
        configKeys: INVITE_PROGRAM_CONFIG_KEYS,
      },
      { kind: 'view', view: 'announcements', label: '公告管理', configKeys: [] },
    ],
  },
  {
    id: 'image',
    label: '图片',
    items: [
      {
        kind: 'view',
        view: 'image_generation_config',
        label: '图片生成配置',
        configKeys: IMAGE_GENERATION_CONFIG_KEYS,
      },
      {
        kind: 'view',
        view: 'image_plaza',
        label: '图片广场',
        configKeys: IMAGE_PLAZA_CONFIG_KEYS,
      },
    ],
  },
];

export interface ConfigMenuLocation {
  groupId: string;
  groupLabel: string;
  /** 菜单里的入口名，如“VIP 策略”“兜底配置”。 */
  entryLabel: string | null;
}

/** 某个 managed config 在菜单里的位置；同一 key 出现在多个入口时取第一个。没有入口时返回 null。 */
export function findConfigMenuLocation(
  key: ManagedConfigKey,
  configLabel: (key: ManagedConfigKey) => string
): ConfigMenuLocation | null {
  for (const group of ADMIN_MENU_GROUPS) {
    for (const item of group.items) {
      if (item.kind === 'config' && item.key === key) {
        return {
          groupId: group.id,
          groupLabel: group.label,
          entryLabel: item.label ?? configLabel(key),
        };
      }
      if (item.kind === 'view' && item.configKeys.includes(key)) {
        return { groupId: group.id, groupLabel: group.label, entryLabel: item.label };
      }
    }
  }
  return null;
}
