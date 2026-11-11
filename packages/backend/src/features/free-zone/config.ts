/**
 * 读取畅聊运营配置。缺失或非法时回落到默认值（总开关关、候选为空），等于栏目不存在。
 * 读失败时沿用上一次成功解析的配置：不因为一次配置读抖动把在用的栏目关掉。
 */
import {
  DEFAULT_FREE_ZONE_CONFIG,
  FREE_ZONE_CONFIG_KEY,
  FreeZoneConfigSchema,
  type FreeZoneConfig,
} from '@miniapp/shared';
import { createLogger } from '../../lib/logger.js';
import { fetchRuntimeConfigEntries } from '../../platform/runtime-config.js';

const log = createLogger('free-zone');

let cached: FreeZoneConfig | null = null;
let cachedVersion: number | null = null;

export async function fetchFreeZoneConfig(): Promise<FreeZoneConfig> {
  let entry;
  try {
    entry = (await fetchRuntimeConfigEntries([FREE_ZONE_CONFIG_KEY])).get(FREE_ZONE_CONFIG_KEY);
  } catch (err) {
    log.sys.error({ err, event: 'free_zone.config.read_failed' }, '畅聊配置读取失败，沿用上次配置');
    return cached ?? DEFAULT_FREE_ZONE_CONFIG;
  }
  if (!entry) return DEFAULT_FREE_ZONE_CONFIG;
  if (cached && cachedVersion === entry.version) return cached;

  const parsed = FreeZoneConfigSchema.safeParse(entry.value);
  if (!parsed.success) {
    log.sys.error(
      {
        event: 'free_zone.config.invalid',
        version: entry.version,
        issues: parsed.error.issues.length,
      },
      '畅聊配置不合法，按关闭处理'
    );
  }
  cached = parsed.success ? parsed.data : DEFAULT_FREE_ZONE_CONFIG;
  cachedVersion = entry.version;
  return cached;
}
