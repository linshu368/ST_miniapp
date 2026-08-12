// 聊天链路的全局切换开关（M6）：决定客户端走 ST iframe 还是自研对话链路。
// 方案：docs/ST_remove.md §阶段二（全局开关 + 回滚窗口）。
//
// 权威源是 miniapp.runtime_config 的 chat_engine_mode（migration 075），
// 对外只有一个出口：GET /api/platform/chat-engine。前端据此决定聊天入口路由，
// 以及是否挂载 ST iframe / bridge / provision 链路。

export const CHAT_ENGINE_MODES = ['sillytavern', 'self_hosted'] as const;

export type ChatEngineMode = (typeof CHAT_ENGINE_MODES)[number];

/** runtime_config 缺失或格式非法时的兜底：留在旧链路，切换必须是显式动作 */
export const DEFAULT_CHAT_ENGINE_MODE: ChatEngineMode = 'sillytavern';

export const CHAT_ENGINE_MODE_CONFIG_KEY = 'chat_engine_mode';

export interface GetChatEngineData {
  mode: ChatEngineMode;
  /** true = 读到的是兜底值而非运营配置；客户端不消费，用于排障时一眼看出开关没生效的原因 */
  degraded: boolean;
}

export function isChatEngineMode(value: unknown): value is ChatEngineMode {
  return typeof value === 'string' && (CHAT_ENGINE_MODES as readonly string[]).includes(value);
}
