import { managedConfigKeys, type ManagedConfigKey } from './configSchemas';

export type AdminViewKey =
  | 'configs'
  | 'outreach_credit_grant'
  | 'characters'
  | 'announcements'
  | 'releases';

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
      return { view: 'configs', configKey };
    }
  }
  if (
    key === 'outreach_credit_grant' ||
    key === 'characters' ||
    key === 'announcements' ||
    key === 'releases'
  ) {
    return { view: key };
  }
  return { view: 'configs' };
}
