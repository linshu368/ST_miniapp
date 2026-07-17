import { managedConfigKeys, type ManagedConfigKey } from './configSchemas';

export type AdminViewKey = 'configs' | 'characters' | 'releases' | 'audit';

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
  if (key === 'characters' || key === 'releases' || key === 'audit') {
    return { view: key };
  }
  return { view: 'configs' };
}
