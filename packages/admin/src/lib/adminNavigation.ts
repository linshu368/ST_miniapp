import { managedConfigKeys, type ManagedConfigKey } from './configSchemas';

export type AdminViewKey =
  | 'configs'
  | 'outreach_credit_grant'
  | 'invite_program'
  | 'characters'
  | 'announcements'
  | 'releases';

/**
 * 裂变邀请的三个 managed config 不在侧栏单独成目录，
 * 统一收进「裂变邀请管理」视图作为 tab（顺序即 tab 顺序，末位固定加「邀请数据」）。
 */
export const INVITE_PROGRAM_CONFIG_KEYS = [
  'miniapp_invite_reward_rules',
  'miniapp_invite_center_config',
  'miniapp_invite_entry_enabled',
] as const satisfies readonly ManagedConfigKey[];

export type InviteProgramConfigKey = (typeof INVITE_PROGRAM_CONFIG_KEYS)[number];
export type InviteProgramTabKey = InviteProgramConfigKey | 'records';

export function isInviteProgramConfigKey(key: ManagedConfigKey): key is InviteProgramConfigKey {
  return (INVITE_PROGRAM_CONFIG_KEYS as readonly string[]).includes(key);
}

/** 侧栏「运营配置」子菜单实际展示的 config 目录（invite 三项已收进「裂变邀请管理」）。 */
export const sidebarManagedConfigKeys: readonly ManagedConfigKey[] = managedConfigKeys.filter(
  (key) => !isInviteProgramConfigKey(key)
);

const CONFIG_PREFIX = 'config:';

export function configMenuKey(key: ManagedConfigKey): string {
  return `${CONFIG_PREFIX}${key}`;
}

export function resolveAdminMenuSelection(key: string): {
  view: AdminViewKey;
  configKey?: ManagedConfigKey;
} {
  if (key.startsWith(CONFIG_PREFIX)) {
    const configKey = key.slice(CONFIG_PREFIX.length) as ManagedConfigKey;
    if (managedConfigKeys.includes(configKey)) {
      // invite 三个 config 的编辑入口在「裂变邀请管理」的 tab 里，不再落到通用 configs 视图
      return isInviteProgramConfigKey(configKey)
        ? { view: 'invite_program', configKey }
        : { view: 'configs', configKey };
    }
  }
  if (
    key === 'outreach_credit_grant' ||
    key === 'invite_program' ||
    key === 'characters' ||
    key === 'announcements' ||
    key === 'releases'
  ) {
    return { view: key };
  }
  return { view: 'configs' };
}
