-- domain: experience
-- 畅聊专用兜底（Surplus）第二步：一轮对话开头冻结的兜底模型名也接受 Surplus 写法（不带斜杠）。
-- 计划见 .trellis/tasks/11-26-free-zone-pin-fallback/design.md（PR2 热修）。
--
-- 事故（2026-11-26 14:02:47–14:11:20 北京时间，free_zone_config v49 打开 fallback 后）：
--   begin_chat_generation_observation 要求冻结的 fallback_model_id 必须是 OpenRouter 写法（带 "/"），
--   畅聊专用兜底的 Surplus 模型名 deepseek-v4.1-flash-1017 不带斜杠 → 22023 'Invalid frozen fallback model ID'，
--   每个畅聊轮次在建轮次时就失败（84 次请求、8 个用户）；已把 fallback 置空回滚。
--
-- 本文件：只把这一条格式检查放宽为「OpenRouter 写法 或 Surplus 写法（与 shared FreeZoneFallbackSchema.surplus_model 一致）」，
-- 类型、长度 ≤ 200 与其余逻辑不变。锚点必须恰好一处（2026-11-26 生产实测，函数 md5 a2827dea…），已改过跳过；
-- CREATE OR REPLACE 保留原 ACL。不改表、不写数据。
--
-- Verify: bash scripts/test-free-zone-surplus-fallback-chain.sh（整条链路：建轮次 → 兜底意图 → 观测 → 交付预览 → 选交付 → 首字上报）
-- Release: TEST -> Production。后端已在线（只有配置 fallback 才会发 Surplus 模型名），执行后再发布配置。
-- Rollback：把放宽后的条件换回原句（同样锚点替换）；先把 free_zone_config.fallback 置空。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $begin$
DECLARE
  fn regprocedure := 'experience.begin_chat_generation_observation(uuid,jsonb)'::regprocedure;
  d text;
  anchor text := $a$     OR v_fallback !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$' THEN$a$;
  replacement text := $r$     -- 2026-11-26: OpenRouter IDs (vendor/model) or Surplus IDs (no slash) for the free-zone fallback.
     OR (v_fallback !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$'
         AND v_fallback !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]*$') THEN$r$;
BEGIN
  d := replace(pg_get_functiondef(fn), E'\r\n', E'\n');
  IF position('Surplus IDs (no slash) for the free-zone fallback' IN d) > 0 THEN
    RAISE NOTICE 'free_zone_surplus_fallback_begin: already patched, skipped';
    RETURN;
  END IF;
  IF (length(d) - length(replace(d, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'free_zone_surplus_fallback_begin: anchor not found exactly once, refusing';
  END IF;
  EXECUTE replace(d, anchor, replacement);
  RAISE NOTICE 'free_zone_surplus_fallback_begin: patched';
END
$begin$;

COMMIT;
