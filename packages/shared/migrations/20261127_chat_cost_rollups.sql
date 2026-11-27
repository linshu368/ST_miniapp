-- domain: analytics (+ ops 索引)
-- 「聊天｜03 每次调用成本」看板的两张派生表（只供 Grafana 读，产品与计费不读）：
--   analytics.chat_turn_costs          每次聊天调用（一条回复）一行：这一轮全部上游调用的成本之和与成本结构
--   analytics.chat_model_prices_hourly 每小时 × lane × role × 供应商 × 上游模型：成本与 token，算每百万 token 实际单价
-- 成本语义完全取自 analytics.llm_call_costs（美元；待补 = NULL；unavailable 按 0；中转渠道无美元换算 = NULL），
-- 与 analytics.llm_turn_costs 同口径，不另立事实。直接查视图 14 天超过只读数据源 15 秒语句上限（2026-11-27 实测），所以物化成表。
--
-- 内容：
--   1. ops.llm_calls 聊天 lane 的 dispatched_at 部分索引（CONCURRENTLY，事务外，先建）；
--   2. 两张表（RLS，只授 first_token_metrics_reader / service_role SELECT）；
--   3. analytics.refresh_chat_costs(p_since)：按轮 upsert、按小时删后重算、删 180 天前；建议锁防并发；只收最近 31 天；
--   4. pg_cron：chat_costs_recent_15m（每 15 分钟刷最近 26 小时）、chat_costs_week_daily（北京 04:23 刷最近 8 天）；
--      没装 pg_cron（TEST）只建表和函数；
--   5. 回填：北京 2026-11-20 00:00 起（重组 6a-2c-3 归一化记账之后），最多 30 天。
-- 2026-11-27 生产实测：ops.llm_calls 约 49 万行；近 2 天 15056 轮，每轮 model_id / lane 唯一，一轮调用跨度最长 45 秒。
--
-- 发布：TEST 单文件 → 生产单文件。与后端发布互不依赖。
-- 重跑：索引 IF NOT EXISTS、表 IF NOT EXISTS、函数 CREATE OR REPLACE、cron 已存在即跳过；回填 upsert 可重跑。
-- 验证：bash scripts/test-chat-cost-rollups-migration.sh
-- 回滚（不碰源数据）：
--   SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('chat_costs_recent_15m', 'chat_costs_week_daily');
--   DROP FUNCTION analytics.refresh_chat_costs(timestamptz);
--   DROP TABLE analytics.chat_turn_costs, analytics.chat_model_prices_hourly;
--   DROP INDEX CONCURRENTLY ops.llm_calls_chat_dispatched_idx;

-- 1. 索引（事务外）
CREATE INDEX CONCURRENTLY IF NOT EXISTS llm_calls_chat_dispatched_idx
  ON ops.llm_calls (dispatched_at) WHERE lane IN ('chat', 'free_zone');

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 守卫：成本视图的输出列必须是 2026-11-27 生产的样子
DO $guard$
DECLARE
  v_missing TEXT;
BEGIN
  IF to_regclass('analytics.llm_call_costs') IS NULL THEN
    RAISE EXCEPTION 'chat_cost_rollups: analytics.llm_call_costs missing';
  END IF;
  SELECT string_agg(c, ', ') INTO v_missing
    FROM unnest(ARRAY['chat_history_id', 'lane', 'model_id', 'role', 'provider', 'provider_model',
                      'dispatched_at', 'won', 'cost_source', 'cost_pending', 'cost_estimated',
                      'cost_usd', 'prompt_tokens', 'completion_tokens']) AS c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'analytics' AND table_name = 'llm_call_costs' AND column_name = c);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'chat_cost_rollups: llm_call_costs lacks %', v_missing;
  END IF;
END
$guard$;

-- 2. 表
CREATE TABLE IF NOT EXISTS analytics.chat_turn_costs (
  chat_history_id UUID PRIMARY KEY,
  turn_at TIMESTAMPTZ NOT NULL,
  lane TEXT NOT NULL CONSTRAINT chat_turn_costs_lane_check CHECK (lane IN ('chat', 'free_zone')),
  model_id TEXT NOT NULL,
  calls INTEGER NOT NULL,
  primary_calls INTEGER NOT NULL,
  fallback_calls INTEGER NOT NULL,
  rewrite_calls INTEGER NOT NULL,
  total_cost_usd NUMERIC NOT NULL,
  primary_won_cost_usd NUMERIC NOT NULL,
  primary_lost_cost_usd NUMERIC NOT NULL,
  fallback_cost_usd NUMERIC NOT NULL,
  rewrite_cost_usd NUMERIC NOT NULL,
  estimated_cost_usd NUMERIC NOT NULL,
  known_calls INTEGER NOT NULL,
  pending_calls INTEGER NOT NULL,
  unavailable_calls INTEGER NOT NULL,
  prompt_tokens BIGINT NOT NULL,
  completion_tokens BIGINT NOT NULL,
  refreshed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT chat_turn_costs_calls_check CHECK (
    calls = primary_calls + fallback_calls + rewrite_calls
    AND calls >= known_calls + pending_calls + unavailable_calls)
);
CREATE INDEX IF NOT EXISTS chat_turn_costs_turn_at_idx ON analytics.chat_turn_costs (turn_at);
COMMENT ON TABLE analytics.chat_turn_costs IS
  '每次聊天调用（一条回复，chat_history_id 软引用 experience.chat_history）的业务成本：这一轮全部上游调用之和（首发含并发槽位、首字兜底、出字后重写，胜出与落败/取消都算），美元。由 analytics.refresh_chat_costs 刷新（pg_cron），只供 Grafana 读；保留 180 天。口径同 analytics.llm_turn_costs。';
COMMENT ON COLUMN analytics.chat_turn_costs.turn_at IS '这一轮第一次派发上游的时间';
COMMENT ON COLUMN analytics.chat_turn_costs.model_id IS '业务模型：畅聊为候选 id，付费为目录模型 id（同 llm_call_costs.model_id）';
COMMENT ON COLUMN analytics.chat_turn_costs.total_cost_usd IS '已知成本之和；待补（pending）不计，unavailable 按 0';
COMMENT ON COLUMN analytics.chat_turn_costs.primary_won_cost_usd IS '首发里胜出（交付或出字）的那一路';
COMMENT ON COLUMN analytics.chat_turn_costs.primary_lost_cost_usd IS '首发其余各路：并发落败、取消、超时、报错';
COMMENT ON COLUMN analytics.chat_turn_costs.estimated_cost_usd IS '其中按输入 token 粗估的部分（cost_source = estimated）';
COMMENT ON COLUMN analytics.chat_turn_costs.pending_calls IS '成本还没补到的调用数（补成本任务最长查 24 小时、7 天后终结）';
COMMENT ON COLUMN analytics.chat_turn_costs.unavailable_calls IS '成本补不到、按 0 计的调用数';

CREATE TABLE IF NOT EXISTS analytics.chat_model_prices_hourly (
  hour_at TIMESTAMPTZ NOT NULL,
  lane TEXT NOT NULL CONSTRAINT chat_model_prices_hourly_lane_check CHECK (lane IN ('chat', 'free_zone')),
  role TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_model TEXT NOT NULL,
  calls INTEGER NOT NULL,
  priced_calls INTEGER NOT NULL,
  cost_usd NUMERIC NOT NULL,
  prompt_tokens BIGINT NOT NULL,
  completion_tokens BIGINT NOT NULL,
  refreshed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (hour_at, lane, role, provider, provider_model),
  CONSTRAINT chat_model_prices_hourly_calls_check CHECK (priced_calls <= calls)
);
COMMENT ON TABLE analytics.chat_model_prices_hourly IS
  '每小时 × lane × role × 供应商 × 上游模型的调用成本与 token（只算成本已知、非估算、token > 0 的调用），算每百万 token 实际单价（输入输出混合），美元。由 analytics.refresh_chat_costs 刷新，只供 Grafana 读；保留 180 天。';

ALTER TABLE analytics.chat_turn_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.chat_model_prices_hourly ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON analytics.chat_turn_costs, analytics.chat_model_prices_hourly FROM PUBLIC, anon, authenticated;
GRANT SELECT ON analytics.chat_turn_costs, analytics.chat_model_prices_hourly TO service_role, first_token_metrics_reader;
DROP POLICY IF EXISTS chat_turn_costs_read ON analytics.chat_turn_costs;
CREATE POLICY chat_turn_costs_read ON analytics.chat_turn_costs
  FOR SELECT TO first_token_metrics_reader USING (true);
DROP POLICY IF EXISTS chat_model_prices_hourly_read ON analytics.chat_model_prices_hourly;
CREATE POLICY chat_model_prices_hourly_read ON analytics.chat_model_prices_hourly
  FOR SELECT TO first_token_metrics_reader USING (true);

-- 3. 刷新函数
CREATE OR REPLACE FUNCTION analytics.refresh_chat_costs(p_since TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  -- 整点对齐：小时表按整点删后重算，不留半个小时
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
  CREATE TEMP TABLE chat_cost_calls ON COMMIT DROP AS
  SELECT c.chat_history_id, c.lane, c.model_id, COALESCE(c.role, 'primary') AS role, c.provider,
         COALESCE(NULLIF(c.provider_model, ''), 'unknown') AS provider_model, c.dispatched_at,
         c.won IS TRUE AS won, c.cost_source, c.cost_pending IS TRUE AS cost_pending,
         c.cost_estimated IS TRUE AS cost_estimated, c.cost_usd,
         COALESCE(c.prompt_tokens, 0) AS prompt_tokens, COALESCE(c.completion_tokens, 0) AS completion_tokens
    FROM analytics.llm_call_costs c
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
         count(*) FILTER (WHERE NOT cost_pending AND cost_source IS DISTINCT FROM 'unavailable'),
         count(*) FILTER (WHERE cost_pending),
         count(*) FILTER (WHERE NOT cost_pending AND cost_source = 'unavailable'),
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

  -- 单价只看真实账单：估算（只按输入 token）、补不到、待补、没有 token 的都不进分子分母
  DELETE FROM analytics.chat_model_prices_hourly WHERE hour_at >= v_since;
  INSERT INTO analytics.chat_model_prices_hourly (
    hour_at, lane, role, provider, provider_model, calls, priced_calls, cost_usd, prompt_tokens,
    completion_tokens, refreshed_at)
  SELECT date_trunc('hour', dispatched_at), lane, role, provider, provider_model, count(*),
         count(*) FILTER (WHERE priced), COALESCE(sum(cost_usd) FILTER (WHERE priced), 0),
         COALESCE(sum(prompt_tokens) FILTER (WHERE priced), 0),
         COALESCE(sum(completion_tokens) FILTER (WHERE priced), 0), v_now
    FROM (SELECT *, cost_usd IS NOT NULL AND NOT cost_pending AND NOT cost_estimated
                    AND cost_source IS DISTINCT FROM 'unavailable'
                    AND prompt_tokens + completion_tokens > 0 AS priced
            FROM pg_temp.chat_cost_calls
           WHERE dispatched_at >= v_since AND role IN ('primary', 'fallback', 'rewrite')) p
   GROUP BY 1, 2, 3, 4, 5;

  DELETE FROM analytics.chat_turn_costs WHERE turn_at < v_now - interval '180 days';
  DELETE FROM analytics.chat_model_prices_hourly WHERE hour_at < v_now - interval '180 days';
  DROP TABLE pg_temp.chat_cost_calls;
  RETURN true;
END
$fn$;
REVOKE ALL ON FUNCTION analytics.refresh_chat_costs(TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role, first_token_metrics_reader;
COMMENT ON FUNCTION analytics.refresh_chat_costs(TIMESTAMPTZ) IS
  '重算 p_since（按整点对齐）之后的每轮成本与每小时单价；只收最近 31 天；拿不到建议锁返回 false。pg_cron chat_costs_recent_15m / chat_costs_week_daily 调用。';

-- 4. 定时任务
DO $cron$
BEGIN
  -- 两层 IF：没装 pg_cron 的库（TEST）不能在同一条件里提到 cron.job。
  IF to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'chat_costs_recent_15m') THEN
      -- 成本最长 24 小时内补到，刷 26 小时；一次约 3 万次调用，远低于 10 秒
      PERFORM cron.schedule('chat_costs_recent_15m', '4,19,34,49 * * * *',
        $job$SET statement_timeout = '10s'; SET lock_timeout = '1s'; SET max_parallel_workers_per_gather = 0; SELECT analytics.refresh_chat_costs(now() - interval '26 hours');$job$);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'chat_costs_week_daily') THEN
      -- 补成本任务 7 天后终结：北京 04:23 低峰刷 8 天，接住晚到的成本
      PERFORM cron.schedule('chat_costs_week_daily', '23 20 * * *',
        $job$SET statement_timeout = '60s'; SET lock_timeout = '1s'; SET max_parallel_workers_per_gather = 0; SELECT analytics.refresh_chat_costs(now() - interval '8 days');$job$);
    END IF;
  ELSE
    RAISE NOTICE 'pg_cron unavailable: chat cost tables and refresh function are ready, no schedule configured';
  END IF;
END
$cron$;

-- 5. 回填（北京 2026-11-20 00:00 起，最多 30 天）
SELECT analytics.refresh_chat_costs(GREATEST(timestamptz '2026-11-19 16:00:00+00', clock_timestamp() - interval '30 days'));

-- 尾检
DO $postflight$
BEGIN
  IF to_regclass('ops.llm_calls_chat_dispatched_idx') IS NULL THEN
    RAISE EXCEPTION 'postflight: llm_calls_chat_dispatched_idx missing';
  END IF;
  IF has_function_privilege('first_token_metrics_reader', 'analytics.refresh_chat_costs(timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postflight: reader can execute refresh_chat_costs';
  END IF;
  IF NOT has_table_privilege('first_token_metrics_reader', 'analytics.chat_turn_costs', 'SELECT')
     OR NOT has_table_privilege('first_token_metrics_reader', 'analytics.chat_model_prices_hourly', 'SELECT') THEN
    RAISE EXCEPTION 'postflight: reader cannot read chat cost tables';
  END IF;
END
$postflight$;

COMMIT;
