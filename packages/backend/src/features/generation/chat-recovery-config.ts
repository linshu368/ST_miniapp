/**
 * 运营托管 chat_recovery_config 的读取（契约见 @miniapp/shared chat-recovery.ts）。
 *
 * 每轮聊天出字时都要用，所以进程内缓存 30 秒：过期后先用旧值、后台刷新，只有进程第一次读需要等
 * （最多 1 秒）。读不到、读失败或配坏 → 视为关闭（null），配坏时每个版本记一次 warn。
 */
import {
  CHAT_RECOVERY_CONFIG_KEY,
  ChatRecoveryConfigSchema,
  type ChatRecoveryConfig,
} from '@miniapp/shared';
import { fetchRuntimeConfigEntry } from '../../platform/runtime-config.js';
import { observation } from '../../platform/observability/runtime.js';

const TTL_MS = 30_000;
const FIRST_READ_MS = 1_000;

let cached: { value: ChatRecoveryConfig | null; at: number } | null = null;
let refreshing: Promise<ChatRecoveryConfig | null> | null = null;
let warnedVersion: number | null = null;

async function load(): Promise<ChatRecoveryConfig | null> {
  try {
    const entry = await fetchRuntimeConfigEntry(
      CHAT_RECOVERY_CONFIG_KEY,
      AbortSignal.timeout(FIRST_READ_MS)
    );
    if (!entry) return null;
    const parsed = ChatRecoveryConfigSchema.safeParse(entry.value);
    if (parsed.success) return parsed.data;
    if (warnedVersion !== entry.version) {
      warnedVersion = entry.version;
      observation.emit(
        'config.chat_recovery.invalid',
        'runtime_config.read',
        {
          outcome: 'degraded',
          outcome_known: true,
          resource: CHAT_RECOVERY_CONFIG_KEY,
          config_version: entry.version,
        },
        'warn'
      );
    }
    return null;
  } catch {
    // 读失败已由 runtime-config 记录；这里只保证不影响对话（按关闭处理，下次再读）。
    return cached?.value ?? null;
  }
}

function refresh(): Promise<ChatRecoveryConfig | null> {
  refreshing ??= load()
    .then((value) => {
      cached = { value, at: Date.now() };
      return value;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export async function readChatRecoveryConfig(): Promise<ChatRecoveryConfig | null> {
  if (!cached) return refresh();
  if (Date.now() - cached.at > TTL_MS) void refresh();
  return cached.value;
}

/** 测试用：清掉进程内缓存。 */
export function resetChatRecoveryConfigCache(): void {
  cached = null;
  refreshing = null;
  warnedVersion = null;
}
