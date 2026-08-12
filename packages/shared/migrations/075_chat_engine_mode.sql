-- 聊天链路全局开关（M6）：chat_engine_mode
--
-- 方案：docs/ST_remove.md §阶段二。'sillytavern' = 现有 iframe/bridge 链路，
-- 'self_hosted' = M1–M3b 自研引擎 + M5 独立 UI。后端读取入口见
-- packages/backend/src/platform/chat-engine.ts，对外出口是 GET /api/platform/chat-engine。
--
-- 本迁移只把 key 建出来并置为 'sillytavern'（等于现状），任何环境执行都不改变行为。
-- 切换与回滚都不再走迁移，改用运维脚本，避免每次翻转都要发一个新编号的文件：
--   pnpm --filter @miniapp/backend chat-engine:mode -- self_hosted
--   pnpm --filter @miniapp/backend chat-engine:mode -- sillytavern
--
-- ⚠️ miniapp 与 bot 共用同一个 Supabase 项目，bot 的配置在 public.runtime_config。
--    手工核对时务必写全 `miniapp.runtime_config`。
--
-- 已有值时不覆盖：重跑迁移不应把线上已经切过去的开关打回 ST。

BEGIN;

INSERT INTO miniapp.runtime_config (
  key, value, description, version, updated_at, text_value
) VALUES (
  'chat_engine_mode',
  '{"mode": "sillytavern"}'::JSONB,
  '聊天链路全局开关：sillytavern = ST iframe 链路，self_hosted = 自研引擎 + 独立 UI。',
  1,
  now(),
  NULL
)
ON CONFLICT (key) DO NOTHING;

COMMIT;
