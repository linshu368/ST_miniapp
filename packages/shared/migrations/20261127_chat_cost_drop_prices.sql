-- domain: analytics
-- 「聊天｜03 每次调用成本」去掉按上游模型的单价表（用户 2026-11-27：模型标价参考性不大，成本取决于兜底率、
-- 缓存命中等，只看业务调用维度）。看板已删除两张单价图；这里：
--   1. analytics.refresh_chat_costs 原地替换为只刷每轮成本（与 20261127_chat_cost_rollups.sql 同口径，去掉小时单价那一段）；
--   2. DROP analytics.chat_model_prices_hourly（派生表，只有看板读，可从 llm_call_costs 重算）。
-- 先替换函数再删表，同一事务：cron 任务不会在中间态引用已删除的表。cron 任务的命令不变。
--
-- 发布：TEST 单文件 → 生产单文件（在 20261127_chat_cost_rollups.sql 之后）。与后端无关。
-- 重跑：函数 CREATE OR REPLACE、DROP TABLE IF EXISTS，可重跑。
-- 验证：bash scripts/test-chat-cost-rollups-migration.sh（两份迁移依次执行）
-- 回滚：重新执行 20261127_chat_cost_rollups.sql 的表与函数部分（force_rerun 需审查），单价数据从 llm_call_costs 重算。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
BEGIN
  IF to_regprocedure('analytics.refresh_chat_costs(timestamptz)') IS NULL
     OR to_regclass('analytics.chat_turn_costs') IS NULL THEN
    RAISE EXCEPTION 'chat_cost_drop_prices: run 20261127_chat_cost_rollups.sql first';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION analytics.refresh_chat_costs(p_since TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  -- 整点对齐（与 20261127_chat_cost_rollups.sql 同口径，刷新窗口取整点）
  v_since TIMESTAMPTZ := date_trunc('hour', p_since);
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_since IS NULL OR p_since < v_now - interval '31 days' OR p_since > v_now THEN
    RAISE EXCEPTION 'refresh_chat_costs: p_since must be within the last 31 days' USING ERRCODE = '22023';
  END IF;
  IF NOT pg_try_advisory_xact_lock(20261127, 30) THEN
    RETURN false;
  END IF;

  -- 一轮的调用都在 110 秒执行上限内：多取 5 分钟，再只留首个调用不早于 v_since 的轮，这些轮是完整的；
  -- 跨在 v_since 前后的轮由更早的刷新算过（每 15 分钟刷 26 小时，窗口互相重叠）。
  -- no_charge：上游在出字前就回 4xx 拒绝（如 Surplus 404 minimum_discount_not_met），不产生费用，
  -- 补成本任务记 unavailable、按 0；这里算成本已知（0），不算「补不到」。状态码只在台账里，按主键取。
  CREATE TEMP TABLE chat_cost_calls ON COMMIT DROP AS
  SELECT c.chat_history_id, c.lane, c.model_id, COALESCE(c.role, 'primary') AS role, c.provider,
         COALESCE(NULLIF(c.provider_model, ''), 'unknown') AS provider_model, c.dispatched_at,
         c.won IS TRUE AS won, c.cost_source, c.cost_pending IS TRUE AS cost_pending,
         c.cost_estimated IS TRUE AS cost_estimated, c.cost_usd,
         COALESCE(c.prompt_tokens, 0) AS prompt_tokens, COALESCE(c.completion_tokens, 0) AS completion_tokens,
         (c.cost_source = 'unavailable' AND c.end_reason = 'upstream_error'
           AND l.http_status BETWEEN 400 AND 499) IS TRUE AS no_charge
    FROM analytics.llm_call_costs c
    LEFT JOIN ops.llm_calls l ON l.id = c.id
   WHERE c.dispatched_at >= v_since - interval '5 minutes';

  INSERT INTO analytics.chat_turn_costs AS t (
    chat_history_id, turn_at, lane, model_id, calls, primary_calls, fallback_calls, rewrite_calls,
    total_cost_usd, primary_won_cost_usd, primary_lost_cost_usd, fallback_cost_usd, rewrite_cost_usd,
    estimated_cost_usd, known_calls, pending_calls, unavailable_calls, prompt_tokens, completion_tokens,
    refreshed_at)
  SELECT chat_history_id, min(dispatched_at), min(lane),
         COALESCE(NULLIF(min(model_id) FILTER (WHERE role = 'primary'), ''), NULLIF(min(model_id), ''), 'unknown'),
         count(*), count(*) FILTER (WHERE role = 'primary'), count(*) FILTER (WHERE role = 'fallback'),
         count(*) FILTER (WHERE role = 'rewrite'),
         COALESCE(sum(cost_usd), 0),
         COALESCE(sum(cost_usd) FILTER (WHERE role = 'primary' AND won), 0),
         COALESCE(sum(cost_usd) FILTER (WHERE role = 'primary' AND NOT won), 0),
         COALESCE(sum(cost_usd) FILTER (WHERE role = 'fallback'), 0),
         COALESCE(sum(cost_usd) FILTER (WHERE role = 'rewrite'), 0),
         COALESCE(sum(cost_usd) FILTER (WHERE cost_estimated), 0),
         count(*) FILTER (WHERE NOT cost_pending AND (cost_source IS DISTINCT FROM 'unavailable' OR no_charge)),
         count(*) FILTER (WHERE cost_pending),
         count(*) FILTER (WHERE NOT cost_pending AND cost_source = 'unavailable' AND NOT no_charge),
         sum(prompt_tokens), sum(completion_tokens), v_now
    FROM pg_temp.chat_cost_calls
   WHERE role IN ('primary', 'fallback', 'rewrite')
   GROUP BY chat_history_id
  HAVING min(dispatched_at) >= v_since
  ON CONFLICT (chat_history_id) DO UPDATE SET
    turn_at = EXCLUDED.turn_at, lane = EXCLUDED.lane, model_id = EXCLUDED.model_id,
    calls = EXCLUDED.calls, primary_calls = EXCLUDED.primary_calls,
    fallback_calls = EXCLUDED.fallback_calls, rewrite_calls = EXCLUDED.rewrite_calls,
    total_cost_usd = EXCLUDED.total_cost_usd, primary_won_cost_usd = EXCLUDED.primary_won_cost_usd,
    primary_lost_cost_usd = EXCLUDED.primary_lost_cost_usd, fallback_cost_usd = EXCLUDED.fallback_cost_usd,
    rewrite_cost_usd = EXCLUDED.rewrite_cost_usd, estimated_cost_usd = EXCLUDED.estimated_cost_usd,
    known_calls = EXCLUDED.known_calls, pending_calls = EXCLUDED.pending_calls,
    unavailable_calls = EXCLUDED.unavailable_calls, prompt_tokens = EXCLUDED.prompt_tokens,
    completion_tokens = EXCLUDED.completion_tokens, refreshed_at = EXCLUDED.refreshed_at;

  DELETE FROM analytics.chat_turn_costs WHERE turn_at < v_now - interval '180 days';
  DROP TABLE pg_temp.chat_cost_calls;
  RETURN true;
END
$fn$;
REVOKE ALL ON FUNCTION analytics.refresh_chat_costs(TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role, first_token_metrics_reader;
REVOKE ALL ON FUNCTION analytics.refresh_chat_costs(TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role, first_token_metrics_reader;
COMMENT ON FUNCTION analytics.refresh_chat_costs(TIMESTAMPTZ) IS
  '重算 p_since（按整点对齐）之后的每轮成本；只收最近 31 天；拿不到建议锁返回 false。pg_cron chat_costs_recent_15m / chat_costs_week_daily 调用。';

DROP TABLE IF EXISTS analytics.chat_model_prices_hourly;

DO $postflight$
BEGIN
  IF to_regclass('analytics.chat_model_prices_hourly') IS NOT NULL THEN
    RAISE EXCEPTION 'postflight: chat_model_prices_hourly still exists';
  END IF;
  IF strpos(pg_get_functiondef('analytics.refresh_chat_costs(timestamptz)'::regprocedure), 'chat_model_prices_hourly') > 0 THEN
    RAISE EXCEPTION 'postflight: refresh_chat_costs still references the prices table';
  END IF;
  IF has_function_privilege('first_token_metrics_reader', 'analytics.refresh_chat_costs(timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postflight: reader can execute refresh_chat_costs';
  END IF;
END
$postflight$;

COMMIT;
