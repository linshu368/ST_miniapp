import {
  ADMIN_MENU_GROUPS,
  configMetadata,
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
import { VIP_STRATEGY_CONFIG_KEYS, type VipStrategyConfigKey } from '@miniapp/shared';

export type AdminViewKey =
  | 'configs'
  | 'fallback_config'
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

export function isInviteProgramConfigKey(key: ManagedConfigKey): key is InviteProgramConfigKey {
  return (INVITE_PROGRAM_CONFIG_KEYS as readonly string[]).includes(key);
}

export function isVipStrategyConfigKey(key: ManagedConfigKey): key is VipStrategyConfigKey {
  return (VIP_STRATEGY_CONFIG_KEYS as readonly string[]).includes(key);
}

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

export interface AdminMenuLeaf {
  key: string;
  label: string;
}

export interface AdminMenuGroupNode extends AdminMenuLeaf {
  children: AdminMenuLeaf[];
}

export type AdminMenuNode = AdminMenuLeaf | AdminMenuGroupNode;

function isGroupNode(node: AdminMenuNode): node is AdminMenuGroupNode {
  return 'children' in node;
}

const GROUP_PREFIX = 'group:';

/** 侧栏：按 admin-client 的 ADMIN_MENU_GROUPS 分组（与 CLI 的 config list 同一份），末尾是发布历史。 */
export const ADMIN_MENU: AdminMenuNode[] = [
  ...ADMIN_MENU_GROUPS.map((group) => ({
    key: `${GROUP_PREFIX}${group.id}`,
    label: group.label,
    children: group.items.map((item) =>
      item.kind === 'config'
        ? { key: configMenuKey(item.key), label: item.label ?? configMetadata[item.key].label }
        : { key: item.view, label: item.label }
    ),
  })),
  { key: 'releases', label: '发布历史' },
];

/** 当前选中项所在的分组，用于默认展开。 */
export function menuGroupKeyFor(menuKey: string): string | undefined {
  return ADMIN_MENU.find(
    (node) => isGroupNode(node) && node.children.some((child) => child.key === menuKey)
  )?.key;
}

export function adminMenuLeafKeys(): string[] {
  return ADMIN_MENU.flatMap((node) =>
    isGroupNode(node) ? node.children.map((child) => child.key) : [node.key]
  );
}
