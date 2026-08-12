/**
 * backend / platform / chat-engine.ts
 *
 * 聊天链路全局开关（M6）的读取与缓存。权威源是 miniapp.runtime_config 的
 * chat_engine_mode（migration 075），读法统一走 runtime-config.ts。
 *
 * 缓存 TTL 刻意比模型目录短：这个 key 同时是回滚开关，翻转后要尽快铺开到所有实例。
 */

import {
  CHAT_ENGINE_MODE_CONFIG_KEY,
  DEFAULT_CHAT_ENGINE_MODE,
  isChatEngineMode,
  type ChatEngineMode,
} from '@miniapp/shared';
import { fetchRuntimeConfigEntry } from './runtime-config.js';

export interface ChatEngineSetting {
  mode: ChatEngineMode;
  /** true = 用的是兜底值：key 不存在或值的形状不认识 */
  degraded: boolean;
}

const CACHE_TTL_MS = 30_000;

let cache: { setting: ChatEngineSetting; expiresAt: number } | null = null;

/** 认 `{"mode":"self_hosted"}` 与裸字符串 `"self_hosted"` 两种写法，其余一律兜底 */
export function parseChatEngineMode(value: unknown): ChatEngineSetting {
  if (isChatEngineMode(value)) return { mode: value, degraded: false };

  if (value && typeof value === 'object') {
    const mode = (value as { mode?: unknown }).mode;
    if (isChatEngineMode(mode)) return { mode, degraded: false };
  }

  return { mode: DEFAULT_CHAT_ENGINE_MODE, degraded: true };
}

export async function getChatEngineSetting(): Promise<ChatEngineSetting> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.setting;

  let entry: Awaited<ReturnType<typeof fetchRuntimeConfigEntry>>;
  try {
    entry = await fetchRuntimeConfigEntry(CHAT_ENGINE_MODE_CONFIG_KEY);
  } catch (error) {
    // 这个接口决定客户端挂不挂 ST，宁可回落也不能 500：读挂了不写缓存，下次再试。
    console.error(`[chat-engine] 读取 ${CHAT_ENGINE_MODE_CONFIG_KEY} 抛错，本次回落：`, error);
    return { mode: DEFAULT_CHAT_ENGINE_MODE, degraded: true };
  }

  const setting = parseChatEngineMode(entry?.value);
  if (setting.degraded) {
    console.warn(
      `[chat-engine] ${CHAT_ENGINE_MODE_CONFIG_KEY} 缺失或格式非法，回落到 ${DEFAULT_CHAT_ENGINE_MODE}`
    );
  }

  cache = { setting, expiresAt: now + CACHE_TTL_MS };
  return setting;
}

export function resetChatEngineSettingCache(): void {
  cache = null;
}
