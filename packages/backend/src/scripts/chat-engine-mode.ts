/**
 * 聊天链路全局开关（M6）的读写工具。
 *
 * 读：pnpm --filter @miniapp/backend chat-engine:mode
 * 写：pnpm --filter @miniapp/backend chat-engine:mode -- self_hosted
 *     pnpm --filter @miniapp/backend chat-engine:mode -- sillytavern   # 回滚
 *
 * 目标库由进程拿到的 SUPABASE_* 决定，和后端服务同一套解析。对着 development
 * 环境执行时用 Railway 注入变量，避免把连接串落到本地：
 *   railway run --service stminiapp --environment development -- \
 *     pnpm --filter @miniapp/backend chat-engine:mode -- self_hosted
 */

import { config } from '../platform/config.js';
import { CHAT_ENGINE_MODE_CONFIG_KEY, CHAT_ENGINE_MODES, isChatEngineMode } from '@miniapp/shared';
import { getSupabaseClient } from '../lib/supabase.js';
import { parseChatEngineMode } from '../platform/chat-engine.js';

const db = getSupabaseClient().schema('miniapp');
const target = process.argv[2];

const { data: current, error: readError } = await db
  .from('runtime_config')
  .select('value,version')
  .eq('key', CHAT_ENGINE_MODE_CONFIG_KEY)
  .maybeSingle();

if (readError) {
  console.error(`读取 ${CHAT_ENGINE_MODE_CONFIG_KEY} 失败：${readError.message}`);
  process.exit(1);
}
if (!current) {
  console.error(
    `${CHAT_ENGINE_MODE_CONFIG_KEY} 不存在，请先执行 migration 075_chat_engine_mode.sql`
  );
  process.exit(1);
}

const before = parseChatEngineMode(current.value);
const env = `${config.database.environment} / ${config.database.projectRef}`;

if (!target) {
  console.log(`[${env}] ${CHAT_ENGINE_MODE_CONFIG_KEY} = ${before.mode}`);
  process.exit(0);
}

if (!isChatEngineMode(target)) {
  console.error(`无效模式 "${target}"，可选：${CHAT_ENGINE_MODES.join(' | ')}`);
  process.exit(1);
}

const { error: writeError } = await db
  .from('runtime_config')
  .update({
    value: { mode: target },
    version: (typeof current.version === 'number' ? current.version : 0) + 1,
    updated_at: new Date().toISOString(),
  })
  .eq('key', CHAT_ENGINE_MODE_CONFIG_KEY);

if (writeError) {
  console.error(`写入 ${CHAT_ENGINE_MODE_CONFIG_KEY} 失败：${writeError.message}`);
  process.exit(1);
}

// 后端各实例有 30s 读缓存，前端还要一次刷新才会重新解析开关。
console.log(`[${env}] ${CHAT_ENGINE_MODE_CONFIG_KEY}: ${before.mode} → ${target}`);
console.log('后端缓存 30s 后全量生效；客户端需刷新一次 MiniApp。');
