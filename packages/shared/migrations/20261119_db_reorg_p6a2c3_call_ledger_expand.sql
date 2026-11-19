-- Domain: ops（上游模型调用）——数据库重组阶段 6a-2c-3 扩展：文本对话模型调用归一化 + 每轮总成本。
-- 计划见 .trellis/tasks/11-19-db-reorg-p6-billing/design.md（6a-2c-3）。
--
-- 目标：ops.llm_calls 每次上游调用一行（收费轮每个 attempt + 畅聊每个槽位），每轮成本 = 首发 + 兜底全部调用成本之和。
-- 本文件（扩展，后端发布前执行；不删任何东西）：
--   1. ops.llm_calls 加列 lane（chat / free_zone）、role、slot、candidate_id、dispatched_at、end_reason（约束 NOT VALID
--      后单独 VALIDATE，不长时间锁表）；Surplus 每轮唯一索引改为只约束代表 attempt 的那一行（attempt_id 非空），
--      畅聊并发的 Surplus 槽位另起行；待补成本的部分索引；ops.llm_cost_jobs 的 kind 加 call_cost、次数上限 6 → 8
--      （畅聊 OpenRouter 查询上限是 8）。新索引 CONCURRENTLY 建，不阻塞写入。
--   2. 搬数据（一个 DO 块；只增补，不覆盖已有成本）：
--      a. 近 7 天收费轮的 attempt：已有调用行的补 role / dispatched_at / end_reason；没有的（未交付的 OpenRouter / Venice）
--         建最小行，成本待补（cost_source 为空）。
--      b. 畅聊 miniapp_features.free_zone_calls 全部行：代表 attempt 的那一路（按 generation_id 一一对上；attempt 没有
--         generation_id 时取胜出或最后派出的那一路）并入 attempt 那一行（lane=free_zone，补槽位与时间，成本只补空值），
--         其余各路以原 id 另起行；OpenRouter 已查过的次数进 ops.llm_cost_jobs。
--      c. attempts.discarded_response 复制到 discarded_detail（没有调用行的建最小行）。7 天前的只搬片段、成本标
--         unavailable，不补派出时间与角色——成本视图只收新机制记过账的调用，旧轮次不冒充 0 成本出现。
--   3. experience.list_llm_call_metadata_gaps 去掉 finish_reason / latency / generation_time 条件（原文 md5 守卫）：
--      OpenRouter 有些生成永远不返回这些字段，被反复扫到、占满 sync-job 每轮的查询预算。缺口只看成本与用量。
--   4. 分析视图 miniapp_analytics.llm_call_costs（每次调用）与 llm_turn_costs（每轮总成本），授权同畅聊成本视图。
--      畅聊两个旧视图不动，收缩时改为新视图的子集。
-- 重跑安全：每段都只补缺失的部分。
--
-- Verify: bash scripts/test-db-reorg-p6a2c3-migration.sh
-- Release: TEST -> Production -> 后端发布（onCallSettled 所有轮次统一记账、补查任务通用化）-> 收缩。
-- Recovery: 新列与视图可保留；需要回退时删视图与新增列、恢复原索引条件与缺口函数（本文件头部有原文 md5）。

-- 0. Leftovers of an interrupted CONCURRENTLY build are invalid indexes; drop them so the rerun rebuilds.
DO $cleanup$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('ops.llm_calls_surplus_attempt_turn_idx') AND NOT indisvalid) THEN
    DROP INDEX ops.llm_calls_surplus_attempt_turn_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('ops.llm_calls_cost_pending_idx') AND NOT indisvalid) THEN
    DROP INDEX ops.llm_calls_cost_pending_idx;
  END IF;
END
$cleanup$;

-- 1. Columns and constraints (catalog-only; constraints NOT VALID, validated below without blocking writes).
DO $columns$
BEGIN
  SET LOCAL lock_timeout = '5s';
  ALTER TABLE ops.llm_calls
    ADD COLUMN IF NOT EXISTS lane text NOT NULL DEFAULT 'chat',
    ADD COLUMN IF NOT EXISTS role text,
    ADD COLUMN IF NOT EXISTS slot smallint,
    ADD COLUMN IF NOT EXISTS candidate_id text,
    ADD COLUMN IF NOT EXISTS dispatched_at timestamptz,
    ADD COLUMN IF NOT EXISTS end_reason text;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ops.llm_calls'::regclass AND conname = 'llm_calls_lane_check') THEN
    ALTER TABLE ops.llm_calls
      ADD CONSTRAINT llm_calls_lane_check CHECK (lane IN ('chat', 'free_zone')) NOT VALID,
      ADD CONSTRAINT llm_calls_role_check CHECK (role IS NULL OR role IN ('primary', 'fallback')) NOT VALID,
      ADD CONSTRAINT llm_calls_slot_check CHECK (slot IS NULL OR slot BETWEEN 0 AND 2) NOT VALID,
      ADD CONSTRAINT llm_calls_candidate_check CHECK (candidate_id IS NULL OR length(candidate_id) BETWEEN 1 AND 64) NOT VALID,
      ADD CONSTRAINT llm_calls_end_reason_check CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 32) NOT VALID;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ops.llm_cost_jobs'::regclass AND conname = 'llm_cost_jobs_kind_check'
             AND pg_get_constraintdef(oid) NOT LIKE '%call_cost%') THEN
    ALTER TABLE ops.llm_cost_jobs
      DROP CONSTRAINT llm_cost_jobs_kind_check,
      ADD CONSTRAINT llm_cost_jobs_kind_check CHECK (kind IN ('surplus_request_record', 'call_cost')),
      DROP CONSTRAINT llm_cost_jobs_attempts_check,
      ADD CONSTRAINT llm_cost_jobs_attempts_check CHECK (attempts >= 0 AND attempts <= 8);
  END IF;
END
$columns$;
ALTER TABLE ops.llm_calls VALIDATE CONSTRAINT llm_calls_lane_check;
ALTER TABLE ops.llm_calls VALIDATE CONSTRAINT llm_calls_role_check;
ALTER TABLE ops.llm_calls VALIDATE CONSTRAINT llm_calls_slot_check;
ALTER TABLE ops.llm_calls VALIDATE CONSTRAINT llm_calls_candidate_check;
ALTER TABLE ops.llm_calls VALIDATE CONSTRAINT llm_calls_end_reason_check;
COMMENT ON COLUMN ops.llm_calls.lane IS 'chat：收费轮；free_zone：畅聊（每轮多路多槽）';
COMMENT ON COLUMN ops.llm_calls.attempt_id IS
  '代表 experience.chat_generation_attempts 的那一路（= id）；畅聊并发的其余槽位为空';
COMMENT ON COLUMN ops.llm_calls.cost_source IS
  '成本来源：surplus_buyer / openrouter_usage / venice_usage / surplus_bill* / openrouter_generation（实测）、estimated（同类均价）、unavailable（拿不到，汇总按 0）；为空 = 待补（只看最近 7 天）';

-- 2. Indexes without blocking writes: one Surplus row per turn only for the row representing the attempt.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS llm_calls_surplus_attempt_turn_idx
  ON ops.llm_calls (chat_history_id) WHERE provider = 'surplus' AND attempt_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS llm_calls_cost_pending_idx
  ON ops.llm_calls (dispatched_at) WHERE cost_source IS NULL AND dispatched_at IS NOT NULL;
DO $swap_index$
BEGIN
  SET LOCAL lock_timeout = '5s';
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = 'ops.llm_calls_surplus_attempt_turn_idx'::regclass AND indisvalid)
     OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = 'ops.llm_calls_cost_pending_idx'::regclass AND indisvalid) THEN
    RAISE EXCEPTION 'p6a2c3: new indexes are not valid, rerun this file';
  END IF;
  DROP INDEX IF EXISTS ops.llm_calls_surplus_turn_idx;
END
$swap_index$;

-- 3. Data: only fills what is missing; never overwrites a known cost.
DO $copy$
DECLARE
  v_since CONSTANT timestamptz := now() - interval '7 days';
  v_filled bigint; v_created bigint; v_fz_merged bigint; v_fz_rows bigint; v_jobs bigint; v_discarded bigint;
BEGIN
  -- a. Paid-lane attempts of the last 7 days (free-zone turns are handled in b).
  UPDATE ops.llm_calls l
     SET role = COALESCE(l.role, a.role),
         dispatched_at = COALESCE(l.dispatched_at, a.dispatched_at),
         end_reason = COALESCE(l.end_reason, a.end_reason),
         updated_at = now()
    FROM experience.chat_generation_attempts a
   WHERE l.id = a.id AND a.dispatched_at >= v_since
     AND (l.role IS NULL OR l.dispatched_at IS NULL OR l.end_reason IS NULL);
  GET DIAGNOSTICS v_filled = ROW_COUNT;

  INSERT INTO ops.llm_calls (id, attempt_id, chat_history_id, provider, model, generation_id, lane, role, slot,
                             dispatched_at, end_reason)
  SELECT a.id, a.id, a.chat_history_id, a.provider, a.provider_model_id, a.generation_id, 'chat', a.role, 0,
         a.dispatched_at, a.end_reason
    FROM experience.chat_generation_attempts a
   WHERE a.dispatched_at >= v_since
     AND a.provider IN ('openrouter', 'venice', 'surplus')
     AND NOT EXISTS (SELECT 1 FROM miniapp_features.free_zone_calls f WHERE f.chat_history_id = a.chat_history_id)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_created = ROW_COUNT;

  -- b. Free-zone calls: the slot representing each attempt joins the attempt's row, the others get their own rows.
  CREATE TEMP TABLE fz_owner ON COMMIT DROP AS
  SELECT DISTINCT ON (a.id) a.id AS attempt_id, f.id AS call_id
    FROM experience.chat_generation_attempts a
    JOIN miniapp_features.free_zone_calls f ON f.chat_history_id = a.chat_history_id AND f.role = a.role
   WHERE a.generation_id IS NULL OR f.generation_id = a.generation_id
   ORDER BY a.id, (f.generation_id IS NOT DISTINCT FROM a.generation_id) DESC,
            (f.end_reason = 'first_token_observed') DESC, f.dispatched_at DESC, f.slot DESC;

  INSERT INTO ops.llm_calls AS l (id, attempt_id, chat_history_id, provider, model, generation_id, request_id, lane,
                                  role, slot, candidate_id, dispatched_at, end_reason, cost_usd, cost_source,
                                  prompt_tokens, completion_tokens)
  SELECT o.attempt_id, o.attempt_id, f.chat_history_id, f.provider, f.provider_model, f.generation_id, f.request_id,
         'free_zone', f.role, f.slot, f.candidate_id, f.dispatched_at, f.end_reason, f.cost_usd, f.cost_source,
         f.prompt_tokens, f.completion_tokens
    FROM fz_owner o JOIN miniapp_features.free_zone_calls f ON f.id = o.call_id
  ON CONFLICT (id) DO UPDATE SET
    lane = 'free_zone',
    role = COALESCE(l.role, EXCLUDED.role),
    slot = COALESCE(l.slot, EXCLUDED.slot),
    candidate_id = COALESCE(l.candidate_id, EXCLUDED.candidate_id),
    dispatched_at = COALESCE(l.dispatched_at, EXCLUDED.dispatched_at),
    end_reason = COALESCE(l.end_reason, EXCLUDED.end_reason),
    model = COALESCE(l.model, EXCLUDED.model),
    generation_id = COALESCE(l.generation_id, EXCLUDED.generation_id),
    request_id = COALESCE(l.request_id, EXCLUDED.request_id),
    cost_usd = COALESCE(l.cost_usd, EXCLUDED.cost_usd),
    cost_source = CASE WHEN l.cost_usd IS NOT NULL THEN l.cost_source ELSE COALESCE(EXCLUDED.cost_source, l.cost_source) END,
    prompt_tokens = COALESCE(l.prompt_tokens, EXCLUDED.prompt_tokens),
    completion_tokens = COALESCE(l.completion_tokens, EXCLUDED.completion_tokens),
    updated_at = now();
  GET DIAGNOSTICS v_fz_merged = ROW_COUNT;

  INSERT INTO ops.llm_calls (id, attempt_id, chat_history_id, provider, model, generation_id, request_id, lane, role,
                             slot, candidate_id, dispatched_at, end_reason, cost_usd, cost_source, prompt_tokens,
                             completion_tokens, created_at)
  SELECT f.id, NULL, f.chat_history_id, f.provider, f.provider_model, f.generation_id, f.request_id, 'free_zone',
         f.role, f.slot, f.candidate_id, f.dispatched_at, f.end_reason, f.cost_usd, f.cost_source, f.prompt_tokens,
         f.completion_tokens, f.created_at
    FROM miniapp_features.free_zone_calls f
   WHERE NOT EXISTS (SELECT 1 FROM fz_owner o WHERE o.call_id = f.id)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_fz_rows = ROW_COUNT;

  INSERT INTO ops.llm_cost_jobs (call_id, kind, status, attempts, updated_at)
  SELECT COALESCE(o.attempt_id, f.id), 'call_cost', 'pending', least(f.cost_attempts, 8), now()
    FROM miniapp_features.free_zone_calls f
    LEFT JOIN fz_owner o ON o.call_id = f.id
    JOIN ops.llm_calls l ON l.id = COALESCE(o.attempt_id, f.id)
   WHERE f.provider = 'openrouter' AND f.cost_source IS NULL AND f.cost_attempts > 0 AND l.cost_source IS NULL
  ON CONFLICT (call_id) DO NOTHING;
  GET DIAGNOSTICS v_jobs = ROW_COUNT;

  -- c. Discarded fragments of race losers.
  INSERT INTO ops.llm_calls (id, attempt_id, chat_history_id, provider, model, generation_id, lane, role, slot,
                             dispatched_at, end_reason, cost_source)
  SELECT a.id, a.id, a.chat_history_id, a.provider, a.provider_model_id, a.generation_id, 'chat',
         CASE WHEN a.dispatched_at >= v_since THEN a.role END, CASE WHEN a.dispatched_at >= v_since THEN 0 END,
         CASE WHEN a.dispatched_at >= v_since THEN a.dispatched_at END,
         CASE WHEN a.dispatched_at >= v_since THEN a.end_reason END,
         CASE WHEN a.dispatched_at < v_since THEN 'unavailable' END
    FROM experience.chat_generation_attempts a
   WHERE a.discarded_response IS NOT NULL AND a.dispatched_at IS NOT NULL
     AND a.provider IN ('openrouter', 'venice', 'surplus')
  ON CONFLICT (id) DO NOTHING;
  UPDATE ops.llm_calls l
     SET discarded_detail = a.discarded_response,
         updated_at = now()
    FROM experience.chat_generation_attempts a
   WHERE l.id = a.id AND a.discarded_response IS NOT NULL AND l.discarded_detail IS NULL;
  GET DIAGNOSTICS v_discarded = ROW_COUNT;

  RAISE NOTICE 'p6a2c3: paid attempts filled % / created %, free-zone merged % / own rows %, cost jobs %, discarded %',
    v_filled, v_created, v_fz_merged, v_fz_rows, v_jobs, v_discarded;
END
$copy$;

-- 4. Metadata gaps: cost and usage only (production original md5 060475b80ecf39ecdbdaeb8a426d5b34).
DO $gaps$
DECLARE
  v_md5 text := (SELECT md5(prosrc) FROM pg_proc
                 WHERE oid = 'experience.list_llm_call_metadata_gaps(timestamptz,integer)'::regprocedure);
BEGIN
  IF v_md5 = '060475b80ecf39ecdbdaeb8a426d5b34' THEN
    EXECUTE $fn$
CREATE OR REPLACE FUNCTION experience.list_llm_call_metadata_gaps(p_since timestamp with time zone, p_limit integer)
 RETURNS TABLE(id uuid, user_id uuid, model text, session_id uuid, llm_finish_reason text, llm_charge_id uuid, assistant_reply text, status text, llm_billing_snapshot jsonb, llm_billing_settled_at timestamp with time zone, delivery_provider text, generation_id text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $body$
  -- db reorg 6a-2c-3: a gap is a missing cost or usage. finish_reason / latency / generation_time are optional
  -- (OpenRouter never returns them for some generations), so they no longer keep a turn in the scan forever.
  SELECT h.id, h.user_id, h.model, h.session_id, h.llm_finish_reason, h.llm_charge_id, h.assistant_reply, h.status,
    h.llm_billing_snapshot, h.llm_billing_settled_at, a.provider, a.generation_id
  FROM experience.chat_history h
  JOIN experience.chat_generation_requests r ON r.chat_history_id = h.id
  JOIN experience.chat_generation_attempts a ON a.id = r.delivery_attempt_id
  LEFT JOIN ops.llm_calls l ON l.id = a.id
  WHERE h.created_at >= p_since
    AND h.status <> 'streaming'
    AND a.provider = 'openrouter'
    AND a.generation_id IS NOT NULL
    AND (l.id IS NULL OR l.raw_usage IS NULL OR l.cost_usd IS NULL)
  ORDER BY h.created_at DESC, h.id
  LIMIT least(greatest(COALESCE(p_limit, 50), 1), 50)
$body$
$fn$;
  ELSIF v_md5 IS DISTINCT FROM md5($new$
  -- db reorg 6a-2c-3: a gap is a missing cost or usage. finish_reason / latency / generation_time are optional
  -- (OpenRouter never returns them for some generations), so they no longer keep a turn in the scan forever.
  SELECT h.id, h.user_id, h.model, h.session_id, h.llm_finish_reason, h.llm_charge_id, h.assistant_reply, h.status,
    h.llm_billing_snapshot, h.llm_billing_settled_at, a.provider, a.generation_id
  FROM experience.chat_history h
  JOIN experience.chat_generation_requests r ON r.chat_history_id = h.id
  JOIN experience.chat_generation_attempts a ON a.id = r.delivery_attempt_id
  LEFT JOIN ops.llm_calls l ON l.id = a.id
  WHERE h.created_at >= p_since
    AND h.status <> 'streaming'
    AND a.provider = 'openrouter'
    AND a.generation_id IS NOT NULL
    AND (l.id IS NULL OR l.raw_usage IS NULL OR l.cost_usd IS NULL)
  ORDER BY h.created_at DESC, h.id
  LIMIT least(greatest(COALESCE(p_limit, 50), 1), 50)
$new$) THEN
    RAISE EXCEPTION 'p6a2c3: list_llm_call_metadata_gaps drifted (md5 %), refusing', v_md5;
  END IF;
END
$gaps$;

-- 5. Analysis views: one row per call, and the per-turn total (primary + fallback, all providers, USD).
CREATE OR REPLACE VIEW miniapp_analytics.llm_call_costs AS
SELECT l.id,
       l.chat_history_id,
       l.lane,
       CASE WHEN l.lane = 'free_zone' THEN l.candidate_id ELSE h.model END AS model_id,
       l.role,
       l.slot,
       l.provider,
       l.model AS provider_model,
       l.dispatched_at,
       l.end_reason,
       (l.end_reason = 'first_token_observed') AS won,
       l.cost_source,
       (l.cost_source IS NULL) AS cost_pending,
       (l.cost_source = 'estimated') AS cost_estimated,
       CASE WHEN l.cost_source IS NOT NULL THEN COALESCE(l.cost_usd, 0) END AS cost_usd,
       l.prompt_tokens,
       l.completion_tokens
  FROM ops.llm_calls l
  LEFT JOIN experience.chat_history h ON h.id = l.chat_history_id
 WHERE l.dispatched_at IS NOT NULL;
COMMENT ON VIEW miniapp_analytics.llm_call_costs IS
  '每次上游模型调用一行（收费轮与畅聊、首发与兜底、交付与未交付），成本统一美元；拿不到的按 0（cost_source=unavailable），待补的为空。';

CREATE OR REPLACE VIEW miniapp_analytics.llm_turn_costs AS
SELECT chat_history_id,
       lane,
       model_id,
       min(dispatched_at) AS turn_at,
       count(*) FILTER (WHERE role = 'primary') AS primary_calls,
       count(*) FILTER (WHERE role = 'fallback') AS fallback_calls,
       COALESCE(sum(cost_usd) FILTER (WHERE role = 'primary'), 0) AS primary_cost_usd,
       COALESCE(sum(cost_usd) FILTER (WHERE role = 'fallback'), 0) AS fallback_cost_usd,
       COALESCE(sum(cost_usd), 0) AS total_cost_usd,
       COALESCE(sum(cost_usd) FILTER (WHERE cost_estimated), 0) AS estimated_cost_usd,
       bool_or(cost_pending) AS cost_pending
  FROM miniapp_analytics.llm_call_costs
 GROUP BY chat_history_id, lane, model_id;
COMMENT ON VIEW miniapp_analytics.llm_turn_costs IS
  '每轮总成本 = 该轮全部上游调用（首发 + 兜底，含未交付）成本之和，统一美元，不分供应商。';

REVOKE ALL ON miniapp_analytics.llm_call_costs, miniapp_analytics.llm_turn_costs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON miniapp_analytics.llm_call_costs, miniapp_analytics.llm_turn_costs TO service_role, first_token_metrics_reader;
