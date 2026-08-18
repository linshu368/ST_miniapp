-- 083_drop_chat_engine_mode.sql
-- 移除聊天链路全局开关 chat_engine_mode（075 建的那一行）。
--
-- 这个 key 是 ST → 自研引擎切换期的回滚开关：'sillytavern' 挂 iframe 链路，
-- 'self_hosted' 走自研引擎。ST 链路的代码已整体删除（取回见 commit 6206f3a 及其之前的历史），
-- 'sillytavern' 已经没有可回落的目标，开关本身也随本次提交一起删除
-- （前端 lib/api/chat-engine.ts、后端 GET /api/platform/chat-engine 与
-- platform/chat-engine.ts、运维脚本 chat-engine:mode、shared 契约）。
--
-- 执行本迁移前开关就已无任何消费方，删行不改变运行时行为。
-- chat_engine_mode 不在 admin.is_managed_config_key 白名单里，
-- 因此 admin.config_drafts / config_releases 不会有指向它的行。
--
-- 不可回滚：真要恢复 ST 链路，得先把归档代码取回来，再重新 INSERT 这一行。

BEGIN;

DELETE FROM miniapp.runtime_config
WHERE key = 'chat_engine_mode';

COMMIT;
