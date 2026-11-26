-- domain: ops + analytics
-- 状态栏 / 记忆栏的模型调用记进 ops.llm_calls（新 lane），给看板「成本与收入」用。
-- 每次面板模型调用（自动 / 手动，首发 / 兜底，成功或失败）一行；成本由现有 call-costs 任务事后补
-- （OpenRouter 按 generation id、Surplus 按请求号）。面板调用不属于任何聊天轮次：chat_history_id 为空，
-- 因此经营核心（analytics.refresh_core_daily 按当天轮次 id 汇总）不会把它算进聊天成本。
--
-- 只扩展：
--   1. ops.llm_calls.chat_history_id 改可空（只改元数据）；
--   2. llm_calls_lane_check 加 status_bar / memory_bar（NOT VALID，提交后 VALIDATE）；
--   3. 新列 panel_trigger（auto / manual）+ llm_calls_panel_shape_check：聊天 lane 必须有 chat_history_id、
--      不能有 panel_trigger；面板 lane 必须没有 chat_history_id、panel_trigger 必填（NOT VALID，提交后 VALIDATE）；
--   4. analytics.llm_call_costs（每轮成本）只收聊天 lane：在现行定义的 WHERE 上追加 lane 条件，其余不动；
--   5. 新视图 analytics.panel_call_costs（每次面板模型调用的成本）、analytics.panel_refresh_revenue（每次立即更新的星尘），
--      与现有 analytics 视图同样只授 service_role 与 first_token_metrics_reader（Grafana 只读账号所在角色）；
--   6. 面板行的部分索引（CONCURRENTLY，事务外）。
-- 2026-11-26 生产实测：ops.llm_calls 约 48 万行；llm_call_costs 定义末尾为 `WHERE (l.dispatched_at IS NOT NULL);`（md5 f979648d…）。
--
-- 发布：TEST 单文件 → 生产单文件 → 发布写面板行的后端。旧后端不写面板行，先执行无影响。
-- 重跑：每一步已完成即跳过。验证：bash scripts/test-panel-llm-calls-migration.sh
-- 回滚（forward-fix 优先）：停止记账 = 回滚后端。确需清理：
--   DROP VIEW analytics.panel_call_costs, analytics.panel_refresh_revenue;
--   DROP INDEX CONCURRENTLY ops.llm_calls_panel_dispatched_idx;
--   DELETE FROM ops.llm_calls WHERE lane IN ('status_bar','memory_bar');
--   然后恢复 lane 约束为两值、去掉 panel_shape 约束与 panel_trigger 列、chat_history_id SET NOT NULL；
--   llm_call_costs 的 lane 条件可保留（只有聊天 lane 时等价）。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1–3. ops.llm_calls 形状
DO $shape$
DECLARE
  v_lane TEXT;
BEGIN
  IF to_regclass('ops.llm_calls') IS NULL THEN
    RAISE EXCEPTION 'panel_llm_calls: ops.llm_calls missing';
  END IF;

  ALTER TABLE ops.llm_calls ALTER COLUMN chat_history_id DROP NOT NULL;

  SELECT pg_get_constraintdef(oid) INTO v_lane FROM pg_constraint
    WHERE conrelid = 'ops.llm_calls'::regclass AND conname = 'llm_calls_lane_check' AND contype = 'c';
  IF v_lane IS NULL THEN
    RAISE EXCEPTION 'panel_llm_calls: lane constraint missing';
  ELSIF strpos(v_lane, '''status_bar''::text') = 0 THEN
    IF v_lane <> 'CHECK ((lane = ANY (ARRAY[''chat''::text, ''free_zone''::text])))' THEN
      RAISE EXCEPTION 'panel_llm_calls: lane constraint differs: %', v_lane;
    END IF;
    ALTER TABLE ops.llm_calls DROP CONSTRAINT llm_calls_lane_check;
    ALTER TABLE ops.llm_calls ADD CONSTRAINT llm_calls_lane_check
      CHECK (lane IN ('chat', 'free_zone', 'status_bar', 'memory_bar')) NOT VALID;
  END IF;

  ALTER TABLE ops.llm_calls ADD COLUMN IF NOT EXISTS panel_trigger TEXT;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'ops.llm_calls'::regclass AND conname = 'llm_calls_panel_shape_check') THEN
    ALTER TABLE ops.llm_calls ADD CONSTRAINT llm_calls_panel_shape_check CHECK (
      CASE WHEN lane IN ('status_bar', 'memory_bar')
        -- CHECK 遇到 NULL 会放行，所以 panel_trigger 必须显式非空
        THEN chat_history_id IS NULL AND panel_trigger IS NOT NULL AND panel_trigger IN ('auto', 'manual')
        ELSE chat_history_id IS NOT NULL AND panel_trigger IS NULL
      END) NOT VALID;
  END IF;
END;
$shape$;

COMMENT ON COLUMN ops.llm_calls.panel_trigger IS
  '状态栏 / 记忆栏模型调用的触发方式：auto（每 3 轮自动）/ manual（玩家立即更新）；聊天 lane 为空';

-- 4. 每轮成本视图只收聊天 lane（面板行没有轮次，不能以空轮次聚成一行）
DO $turn_costs$
DECLARE
  v_def TEXT := pg_get_viewdef('analytics.llm_call_costs'::regclass);
  v_old CONSTANT TEXT := 'WHERE (l.dispatched_at IS NOT NULL);';
  v_new CONSTANT TEXT := 'WHERE ((l.dispatched_at IS NOT NULL) AND (l.lane = ANY (ARRAY[''chat''::text, ''free_zone''::text])));';
BEGIN
  IF strpos(v_def, 'l.lane = ANY (ARRAY[''chat''::text, ''free_zone''::text])') > 0 THEN
    RETURN;
  END IF;
  IF length(v_def) - length(replace(v_def, v_old, '')) <> length(v_old) OR right(rtrim(v_def), length(v_old)) <> v_old THEN
    RAISE EXCEPTION 'panel_llm_calls: llm_call_costs definition differs';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW analytics.llm_call_costs AS ' || replace(v_def, v_old, v_new);
END;
$turn_costs$;

-- 5. 看板读的两张视图（北京日界；成本待补 / 缺失为空，由看板单独计数，不当 0）
CREATE OR REPLACE VIEW analytics.panel_call_costs AS
SELECT
  l.id,
  (l.dispatched_at AT TIME ZONE 'Asia/Shanghai')::date AS day_cn,
  l.dispatched_at,
  CASE l.lane WHEN 'status_bar' THEN 'status' ELSE 'memory' END AS panel,
  l.panel_trigger,
  l.role,
  l.provider,
  l.model,
  l.end_reason,
  l.end_reason = 'completed' AS returned,
  CASE
    WHEN l.cost_source IS NULL THEN 'pending'
    WHEN l.cost_source = 'unavailable' THEN 'missing'
    WHEN l.cost_source = 'estimated' THEN 'estimated'
    ELSE 'known'
  END AS cost_state,
  CASE WHEN l.cost_source IS NOT NULL AND l.cost_source <> 'unavailable'
    THEN COALESCE(l.cost_usd, 0) END AS cost_usd,
  l.prompt_tokens,
  l.completion_tokens
FROM ops.llm_calls l
WHERE l.lane IN ('status_bar', 'memory_bar') AND l.dispatched_at IS NOT NULL;

COMMENT ON VIEW analytics.panel_call_costs IS
  '状态栏 / 记忆栏每次模型调用一行（首发、兜底、失败都在内）；cost_usd 只在成本已知或估算时有值，pending = 待补、missing = 查不到';

CREATE OR REPLACE VIEW analytics.panel_refresh_revenue AS
SELECT
  u.id,
  (COALESCE(u.settled_at, u.created_at) AT TIME ZONE 'Asia/Shanghai')::date AS day_cn,
  COALESCE(u.settled_at, u.created_at) AS charged_at,
  u.status,
  u.charged_credits AS credits,
  COALESCE((u.quote #>> '{charge,main_credits}')::numeric, 0) AS main_credits,
  COALESCE((u.quote #>> '{charge,bonus_credits}')::numeric, 0) AS bonus_credits
FROM billing.usage_charges u
WHERE u.kind = 'status_refresh';

COMMENT ON VIEW analytics.panel_refresh_revenue IS
  '状态面板立即更新每次扣费一行：status = charged（扣了 credits 星尘，其中通用 main / 专项 bonus）或 failed（余额不足，没扣）';

DO $grants$
DECLARE
  v_view TEXT;
BEGIN
  FOREACH v_view IN ARRAY ARRAY['analytics.panel_call_costs', 'analytics.panel_refresh_revenue'] LOOP
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', v_view);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON %s FROM anon', v_view);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON %s FROM authenticated', v_view);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT SELECT ON %s TO service_role', v_view);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'first_token_metrics_reader') THEN
      EXECUTE format('GRANT SELECT ON %s TO first_token_metrics_reader', v_view);
    END IF;
  END LOOP;
END;
$grants$;

COMMIT;

-- 2–3b. 校验约束（SHARE UPDATE EXCLUSIVE，不挡读写）
SET lock_timeout = '5s';
SET statement_timeout = '300s';
ALTER TABLE ops.llm_calls VALIDATE CONSTRAINT llm_calls_lane_check;
ALTER TABLE ops.llm_calls VALIDATE CONSTRAINT llm_calls_panel_shape_check;

-- 6. 看板按日期扫面板行
CREATE INDEX CONCURRENTLY IF NOT EXISTS llm_calls_panel_dispatched_idx
  ON ops.llm_calls (dispatched_at) WHERE lane IN ('status_bar', 'memory_bar');

-- 尾检
DO $postflight$
BEGIN
  IF (SELECT attnotnull FROM pg_attribute WHERE attrelid = 'ops.llm_calls'::regclass AND attname = 'chat_history_id') THEN
    RAISE EXCEPTION 'postflight: chat_history_id still NOT NULL';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ops.llm_calls'::regclass
                 AND conname = 'llm_calls_lane_check' AND convalidated
                 AND strpos(pg_get_constraintdef(oid), '''memory_bar''::text') > 0) THEN
    RAISE EXCEPTION 'postflight: lane constraint not widened / validated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ops.llm_calls'::regclass
                 AND conname = 'llm_calls_panel_shape_check' AND convalidated) THEN
    RAISE EXCEPTION 'postflight: panel shape constraint missing / not validated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('ops.llm_calls_panel_dispatched_idx')
                 AND indisvalid AND indisready) THEN
    RAISE EXCEPTION 'postflight: panel index not valid';
  END IF;
  IF strpos(pg_get_viewdef('analytics.llm_call_costs'::regclass), 'l.lane = ANY (ARRAY[''chat''::text, ''free_zone''::text])') = 0 THEN
    RAISE EXCEPTION 'postflight: llm_call_costs not limited to chat lanes';
  END IF;
  IF has_table_privilege('anon', 'analytics.panel_call_costs', 'SELECT')
     OR has_table_privilege('authenticated', 'analytics.panel_refresh_revenue', 'SELECT') THEN
    RAISE EXCEPTION 'postflight: panel views exposed to API roles';
  END IF;
END;
$postflight$;

NOTIFY pgrst, 'reload schema';
