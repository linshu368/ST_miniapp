import { managedConfigKeys, type ManagedConfigKey } from './configSchemas';

export const analyticsSections = [
  { key: 'overview', label: '数据总览' },
  { key: 'users', label: '用户与增长' },
  { key: 'retention', label: '活跃与留存' },
  { key: 'chats', label: '对话与内容' },
  { key: 'models', label: '模型与成本' },
  { key: 'characters', label: '角色表现' },
  { key: 'billing', label: '充值与星尘' },
  { key: 'spending', label: '星尘消耗明细' },
  { key: 'checkins', label: '签到与激励' },
  { key: 'growth', label: '渠道归因' },
  { key: 'outreach', label: '客服回访' },
  { key: 'system', label: '系统与同步' },
] as const;

export type AnalyticsSectionKey = (typeof analyticsSections)[number]['key'];
export type AdminViewKey =
  | 'configs'
  | 'outreach_credit_grant'
  | 'characters'
  | 'platform_presets'
  | 'announcements'
  | 'analytics'
  | 'releases'
  | 'audit';

const CONFIG_PREFIX = 'config:';
const ANALYTICS_PREFIX = 'analytics:';

export function configMenuKey(key: ManagedConfigKey): string {
  return `${CONFIG_PREFIX}${key}`;
}

export function analyticsMenuKey(key: AnalyticsSectionKey): string {
  return `${ANALYTICS_PREFIX}${key}`;
}

export function resolveAdminMenuSelection(key: string): {
  view: AdminViewKey;
  configKey?: ManagedConfigKey;
  analyticsKey?: AnalyticsSectionKey;
} {
  if (key.startsWith(CONFIG_PREFIX)) {
    const configKey = key.slice(CONFIG_PREFIX.length) as ManagedConfigKey;
    if (managedConfigKeys.includes(configKey)) {
      return { view: 'configs', configKey };
    }
  }
  if (key.startsWith(ANALYTICS_PREFIX)) {
    const analyticsKey = key.slice(ANALYTICS_PREFIX.length) as AnalyticsSectionKey;
    if (analyticsSections.some((section) => section.key === analyticsKey)) {
      return { view: 'analytics', analyticsKey };
    }
  }
  if (
    key === 'outreach_credit_grant' ||
    key === 'characters' ||
    key === 'platform_presets' ||
    key === 'announcements' ||
    key === 'releases' ||
    key === 'audit'
  ) {
    return { view: key };
  }
  return { view: 'configs' };
}
