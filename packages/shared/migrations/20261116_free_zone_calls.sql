-- Domain: miniapp_features（畅聊每次上游调用的花费）+ miniapp_analytics 只读投影
--
-- 畅聊一轮可能发出多次上游调用：并发 1–3 路免费模型主请求 + 可能启动的兜底。
-- 现有记录每轮只留一条主请求（胜出那一路），落败、被取消的调用也会被 Surplus / OpenRouter
-- 收费，却没有记录。这里每次真正发出的调用记一行，后台任务事后补上真实花费：
--   1) miniapp_features.free_zone_calls：每次调用一行（唯一写入方：后端）
--   2) miniapp_analytics.free_zone_call_costs：每次调用的有效花费（含查不到时的取值规则）
--   3) miniapp_analytics.free_zone_turn_costs：每轮合计
--
-- 花费来源：
--   surplus_bill          Surplus 账单明细里按请求号对上的
--   surplus_bill_matched  没拿到请求号（响应头前就取消），按「同模型 + 结束时间」从账单里配上的
--   openrouter_generation 兜底按生成编号查到的
--   estimated             兜底被取消/超时又查不到：写入定期算好的估算值（近 7 天同类兜底的平均花费）
--   unavailable           查不到，按 0 算（免费模型主请求；兜底一发出就报错的）
--
-- 不建跨 schema 外键：调用记录随功能下线可整体删除。
-- 执行顺序：TEST → 生产 → 部署后端（后端写不进去只记日志，不影响对话）。
-- 回滚：先回退后端，再 DROP VIEW miniapp_analytics.free_zone_turn_costs, miniapp_analytics.free_zone_call_costs;
--   DROP TABLE miniapp_features.free_zone_calls;
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS miniapp_features.free_zone_calls (
  id uuid PRIMARY KEY,
  chat_history_id uuid NOT NULL,
  candidate_id text NOT NULL
    CONSTRAINT free_zone_calls_candidate_check CHECK (length(candidate_id) BETWEEN 1 AND 64),
  role text NOT NULL CONSTRAINT free_zone_calls_role_check CHECK (role IN ('primary', 'fallback')),
  slot smallint NOT NULL CONSTRAINT free_zone_calls_slot_check CHECK (slot BETWEEN 0 AND 2),
  provider text NOT NULL CONSTRAINT free_zone_calls_provider_check CHECK (length(provider) BETWEEN 1 AND 32),
  provider_model text NOT NULL
    CONSTRAINT free_zone_calls_model_check CHECK (length(provider_model) BETWEEN 1 AND 200),
  dispatched_at timestamptz NOT NULL,
  end_reason text NOT NULL
    CONSTRAINT free_zone_calls_end_reason_check CHECK (length(end_reason) BETWEEN 1 AND 32),
  request_id text CONSTRAINT free_zone_calls_request_id_check CHECK (length(request_id) <= 512),
  generation_id text CONSTRAINT free_zone_calls_generation_id_check CHECK (length(generation_id) <= 512),
  cost_usd numeric(20, 9) CONSTRAINT free_zone_calls_cost_check CHECK (cost_usd >= 0),
  cost_source text
    CONSTRAINT free_zone_calls_cost_source_check
    CHECK (cost_source IN ('surplus_bill', 'surplus_bill_matched', 'openrouter_generation',
      'estimated', 'unavailable')),
  prompt_tokens bigint CONSTRAINT free_zone_calls_prompt_tokens_check CHECK (prompt_tokens >= 0),
  completion_tokens bigint
    CONSTRAINT free_zone_calls_completion_tokens_check CHECK (completion_tokens >= 0),
  cost_attempts integer NOT NULL DEFAULT 0
    CONSTRAINT free_zone_calls_attempts_check CHECK (cost_attempts >= 0),
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT free_zone_calls_turn_slot_key UNIQUE (chat_history_id, role, slot),
  CONSTRAINT free_zone_calls_settled_check CHECK ((cost_source IS NULL) = (settled_at IS NULL)),
  CONSTRAINT free_zone_calls_cost_known_check
    CHECK (cost_source IS NULL OR cost_source = 'unavailable' OR cost_usd IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS free_zone_calls_pending_idx
  ON miniapp_features.free_zone_calls (dispatched_at) WHERE cost_source IS NULL;
CREATE INDEX IF NOT EXISTS free_zone_calls_dispatched_idx
  ON miniapp_features.free_zone_calls (dispatched_at);
CREATE INDEX IF NOT EXISTS free_zone_calls_request_idx
  ON miniapp_features.free_zone_calls (request_id) WHERE request_id IS NOT NULL;

ALTER TABLE miniapp_features.free_zone_calls OWNER TO postgres;
ALTER TABLE miniapp_features.free_zone_calls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp_features.free_zone_calls FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON miniapp_features.free_zone_calls TO service_role, postgres;
COMMENT ON TABLE miniapp_features.free_zone_calls IS
  '畅聊每次真正发出的上游调用（每路主请求、兜底各一行）及事后补上的真实花费。唯一写入方：后端。';
COMMENT ON COLUMN miniapp_features.free_zone_calls.slot IS
  '第几路：并发主请求 0–2；兜底恒为 0。';
COMMENT ON COLUMN miniapp_features.free_zone_calls.request_id IS
  'Surplus 请求号（x-si-request-id）。响应头前就取消的调用没有；按账单配上后回填为账单里的请求号。';

-- ── 只读投影 ────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW miniapp_analytics.free_zone_call_costs AS
SELECT
  c.id,
  c.chat_history_id,
  c.candidate_id AS model_id,
  c.role,
  c.slot,
  c.provider,
  c.provider_model,
  c.dispatched_at,
  c.end_reason,
  c.end_reason = 'first_token_observed' AS won,
  c.cost_source,
  c.cost_source IS NULL AS cost_pending,
  c.cost_source = 'estimated' AS cost_estimated,
  -- 查不到（unavailable）按 0；还没核算的为空
  CASE WHEN c.cost_source IS NOT NULL THEN COALESCE(c.cost_usd, 0) END AS cost_usd,
  c.prompt_tokens,
  c.completion_tokens
FROM miniapp_features.free_zone_calls c;

CREATE OR REPLACE VIEW miniapp_analytics.free_zone_turn_costs AS
SELECT
  chat_history_id,
  model_id,
  min(dispatched_at) AS turn_at,
  count(*) FILTER (WHERE role = 'primary') AS primary_calls,
  count(*) FILTER (WHERE role = 'fallback') AS fallback_calls,
  COALESCE(sum(cost_usd) FILTER (WHERE role = 'primary'), 0) AS primary_cost_usd,
  COALESCE(sum(cost_usd) FILTER (WHERE role = 'fallback'), 0) AS fallback_cost_usd,
  COALESCE(sum(cost_usd), 0) AS total_cost_usd,
  COALESCE(sum(cost_usd) FILTER (WHERE cost_estimated), 0) AS estimated_cost_usd,
  bool_or(cost_pending) AS cost_pending
FROM miniapp_analytics.free_zone_call_costs
GROUP BY chat_history_id, model_id;

ALTER VIEW miniapp_analytics.free_zone_call_costs OWNER TO postgres;
ALTER VIEW miniapp_analytics.free_zone_turn_costs OWNER TO postgres;
REVOKE ALL ON miniapp_analytics.free_zone_call_costs, miniapp_analytics.free_zone_turn_costs
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON miniapp_analytics.free_zone_call_costs, miniapp_analytics.free_zone_turn_costs
  TO service_role, postgres;
COMMENT ON VIEW miniapp_analytics.free_zone_turn_costs IS
  '畅聊每轮真实花费：所有主请求（含并发落败、被取消）+ 兜底。cost_pending 的轮次花费还没补齐，统计时排除。';
DO $grafana$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'first_token_metrics_reader') THEN
    GRANT SELECT ON miniapp_analytics.free_zone_call_costs, miniapp_analytics.free_zone_turn_costs
      TO first_token_metrics_reader;
  END IF;
END
$grafana$;

COMMIT;
