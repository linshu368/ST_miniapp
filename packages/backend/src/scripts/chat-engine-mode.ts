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
// pnpm 会把分隔用的 `--` 原样透传给脚本，这里丢掉它
const target = process.argv.slice(2).find((arg) => arg !== '--');

const { data: current, error: readError } = await db
  .from('runtime_config')
  .select('value,version')
  .eq('key', CHAT_ENGINE_MODE_CONFIG_KEY)
  .maybeSingle();

if (readError) {
  console.error(`读取 ${CHAT_ENGINE_MODE_CONFIG_KEY} 失败：${readError.message}`);
  process.exit(1);
}

const before = current ? parseChatEngineMode(current.value) : null;
const env = `${config.database.environment} / ${config.database.projectRef}`;

if (!target) {
  console.log(
    `[${env}] ${CHAT_ENGINE_MODE_CONFIG_KEY} = ${before?.mode ?? '(未配置，按兜底走 ST)'}`
  );
  process.exit(0);
}

if (!isChatEngineMode(target)) {
  console.error(`无效模式 "${target}"，可选：${CHAT_ENGINE_MODES.join(' | ')}`);
  process.exit(1);
}

// upsert 而不是 update：迁移 075 只保证行存在与说明文案，不是这一行的唯一写入方，
// 迁移还没在某个环境跑过时也要能切。
const { error: writeError } = await db.from('runtime_config').upsert(
  {
    key: CHAT_ENGINE_MODE_CONFIG_KEY,
    value: { mode: target },
    version: (typeof current?.version === 'number' ? current.version : 0) + 1,
    updated_at: new Date().toISOString(),
  },
  { onConflict: 'key' }
);

if (writeError) {
  console.error(`写入 ${CHAT_ENGINE_MODE_CONFIG_KEY} 失败：${writeError.message}`);
  process.exit(1);
}

// 后端各实例有 30s 读缓存，前端还要一次刷新才会重新解析开关。
console.log(`[${env}] ${CHAT_ENGINE_MODE_CONFIG_KEY}: ${before?.mode ?? '(未配置)'} → ${target}`);
console.log('后端缓存 30s 后全量生效；客户端需刷新一次 MiniApp。');
