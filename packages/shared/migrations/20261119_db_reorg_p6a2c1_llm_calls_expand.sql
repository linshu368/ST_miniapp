-- 数据库重组 6a-2c-1（扩展）：建 ops.llm_calls，OpenRouter / Venice 调用元数据有新家（后端发布前执行）。
--
-- 做什么（一个事务）：
--   1. ops.llm_calls：每次上游调用一行，id = chat_generation_attempts.id（10-23 之前的旧明细行沿用原行 id，
--      attempt_id 为空）。预留 Surplus 用的列（6a-2c-2 迁入）。成本统一存美元：Venice 的 llm_usage 实为微美元
--      （按每百万 token 单价乘出，看板一直 ÷1e6），这里换算。RLS 开启，只授 service_role（三个 RPC 是调用者权限）。
--   2. experience.record_llm_call_metadata(history, generation_id, metadata)：按 (轮次, generation_id) 定位调用
--      （generation_id 为空时取这一轮的交付调用），只补空值（同一调用的元数据不会变），取代后端对两张明细表的
--      upsert 与占位。
--   3. experience.read_llm_call_metadata(history_ids)：回捞批量读交付的 OpenRouter 调用元数据，字段名保持旧明细表的
--      名字（usage / latency / generation_time / llm_generation_data …），后端判定"是否齐全"的逻辑不变。
--   4. experience.list_llm_call_metadata_gaps(since, limit)：交付调用是 OpenRouter、有 generation_id、轮次已结束，
--      但 ops 里没有行或元数据不全（新的在前），取代 OpenRouter 明细的"待补齐"扫描。
--   5. 复制两张明细表的全部行（只读旧表、只写新表，不锁热表）。复制之后旧后端写入的增量由收缩迁移补齐
--      （只补空值、不覆盖新后端写的值）。
-- 不改交付仲裁、不改看板日汇总、不删表（收缩迁移做）。可重跑（已复制的行跳过）。

BEGIN;
SELECT set_config('statement_timeout', '600s', true);
SELECT set_config('lock_timeout', '5s', true);

CREATE TABLE IF NOT EXISTS ops.llm_calls (
  id uuid PRIMARY KEY,
  attempt_id uuid UNIQUE,
  chat_history_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('openrouter', 'venice', 'surplus')),
  generation_id text,
  request_id text,
  provider_name text,
  model text,
  finish_reason text,
  call_status text,
  error_code text,
  http_status integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  prompt_tokens bigint CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  completion_tokens bigint CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  cached_tokens bigint CHECK (cached_tokens IS NULL OR cached_tokens >= 0),
  reasoning_tokens bigint CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  cost_usd numeric CHECK (cost_usd IS NULL OR cost_usd >= 0),
  cache_cost_usd numeric CHECK (cache_cost_usd IS NULL OR cache_cost_usd >= 0),
  cost_source text,
  latency_ms numeric CHECK (latency_ms IS NULL OR latency_ms >= 0),
  generation_time_ms numeric CHECK (generation_time_ms IS NULL OR generation_time_ms >= 0),
  raw_request jsonb,
  raw_usage jsonb,
  discarded_detail jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT llm_calls_attempt_is_id CHECK (attempt_id IS NULL OR attempt_id = id)
);
CREATE INDEX IF NOT EXISTS llm_calls_chat_history_idx ON ops.llm_calls (chat_history_id);
CREATE INDEX IF NOT EXISTS llm_calls_created_at_idx ON ops.llm_calls (created_at);
ALTER TABLE ops.llm_calls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.llm_calls FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON ops.llm_calls TO service_role;
COMMENT ON TABLE ops.llm_calls IS
  '每次上游模型调用一行（O，保留 180 天）：id = experience.chat_generation_attempts.id（软引用；10-23 前旧明细行沿用原行 id，'
  'attempt_id 为空）。成本统一美元。写入经 experience.record_llm_call_metadata；回捞经 read_llm_call_metadata / '
  'list_llm_call_metadata_gaps 读。不参与"谁交付、扣多少"的判断。';

CREATE OR REPLACE FUNCTION experience.record_llm_call_metadata(
  p_history_id uuid,
  p_generation_id text,
  p_metadata jsonb
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
DECLARE
  a experience.chat_generation_attempts%ROWTYPE;
  v_scale numeric;
BEGIN
  IF btrim(p_generation_id) = '' OR jsonb_typeof(p_metadata) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid LLM call metadata' USING ERRCODE = '22023';
  END IF;
  IF p_generation_id IS NULL THEN
    -- A provider that returned no call ID (some Venice responses): the turn's delivered call.
    SELECT a0.* INTO a FROM experience.chat_generation_requests r
    JOIN experience.chat_generation_attempts a0 ON a0.id = r.delivery_attempt_id
    WHERE r.chat_history_id = p_history_id;
  ELSE
    SELECT * INTO a FROM experience.chat_generation_attempts
    WHERE chat_history_id = p_history_id AND generation_id = p_generation_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LLM call identity not found' USING ERRCODE = 'P0002';
  END IF;
  IF a.provider NOT IN ('openrouter', 'venice') THEN
    RAISE EXCEPTION 'Provider % metadata is recorded by its own call RPC', a.provider USING ERRCODE = '22023';
  END IF;
  -- Venice "usage" is micro-USD (tokens x per-million price); OpenRouter reports USD.
  v_scale := CASE a.provider WHEN 'venice' THEN 1000000 ELSE 1 END;
  INSERT INTO ops.llm_calls AS l (id, attempt_id, chat_history_id, provider, generation_id, provider_name, model,
    finish_reason, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, cost_usd, cache_cost_usd,
    cost_source, latency_ms, generation_time_ms, raw_usage)
  VALUES (a.id, a.id, a.chat_history_id, a.provider, a.generation_id,
    left(p_metadata ->> 'provider_name', 512), left(p_metadata ->> 'model', 512),
    left(p_metadata ->> 'finish_reason', 128),
    (p_metadata ->> 'native_tokens_prompt')::bigint, (p_metadata ->> 'native_tokens_completion')::bigint,
    (p_metadata ->> 'native_tokens_cached')::bigint, (p_metadata ->> 'native_tokens_reasoning')::bigint,
    (p_metadata ->> 'usage')::numeric / v_scale, (p_metadata ->> 'usage_cache')::numeric / v_scale,
    CASE WHEN p_metadata ->> 'usage' IS NOT NULL THEN a.provider || '_usage' END,
    (p_metadata ->> 'latency')::numeric, (p_metadata ->> 'generation_time')::numeric,
    CASE WHEN jsonb_typeof(p_metadata -> 'llm_generation_data') IN ('object', 'array') THEN p_metadata -> 'llm_generation_data' END)
  ON CONFLICT (id) DO UPDATE SET
    provider_name = COALESCE(l.provider_name, EXCLUDED.provider_name),
    model = COALESCE(l.model, EXCLUDED.model),
    finish_reason = COALESCE(l.finish_reason, EXCLUDED.finish_reason),
    prompt_tokens = COALESCE(l.prompt_tokens, EXCLUDED.prompt_tokens),
    completion_tokens = COALESCE(l.completion_tokens, EXCLUDED.completion_tokens),
    cached_tokens = COALESCE(l.cached_tokens, EXCLUDED.cached_tokens),
    reasoning_tokens = COALESCE(l.reasoning_tokens, EXCLUDED.reasoning_tokens),
    cost_usd = COALESCE(l.cost_usd, EXCLUDED.cost_usd),
    cache_cost_usd = COALESCE(l.cache_cost_usd, EXCLUDED.cache_cost_usd),
    cost_source = COALESCE(l.cost_source, EXCLUDED.cost_source),
    latency_ms = COALESCE(l.latency_ms, EXCLUDED.latency_ms),
    generation_time_ms = COALESCE(l.generation_time_ms, EXCLUDED.generation_time_ms),
    raw_usage = COALESCE(l.raw_usage, EXCLUDED.raw_usage),
    updated_at = clock_timestamp();
END
$fn$;

CREATE OR REPLACE FUNCTION experience.read_llm_call_metadata(p_history_ids uuid[])
RETURNS TABLE (
  chat_history_id uuid,
  provider_name text,
  finish_reason text,
  usage numeric,
  usage_cache numeric,
  native_tokens_cached bigint,
  native_tokens_reasoning bigint,
  native_tokens_completion bigint,
  native_tokens_prompt bigint,
  latency numeric,
  generation_time numeric,
  model text,
  llm_generation_data jsonb
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $fn$
  SELECT r.chat_history_id, l.provider_name, l.finish_reason, l.cost_usd, l.cache_cost_usd, l.cached_tokens,
    l.reasoning_tokens, l.completion_tokens, l.prompt_tokens, l.latency_ms, l.generation_time_ms, l.model, l.raw_usage
  FROM experience.chat_generation_requests r
  JOIN ops.llm_calls l ON l.id = r.delivery_attempt_id AND l.provider = 'openrouter'
  WHERE r.chat_history_id = ANY (p_history_ids)
$fn$;

CREATE OR REPLACE FUNCTION experience.list_llm_call_metadata_gaps(p_since timestamptz, p_limit integer)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  model text,
  session_id uuid,
  llm_finish_reason text,
  llm_charge_id uuid,
  assistant_reply text,
  status text,
  llm_billing_snapshot jsonb,
  llm_billing_settled_at timestamptz,
  delivery_provider text,
  generation_id text
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $fn$
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
    AND (l.id IS NULL OR l.raw_usage IS NULL OR l.cost_usd IS NULL OR l.latency_ms IS NULL
      OR l.generation_time_ms IS NULL OR l.finish_reason IS NULL)
  ORDER BY h.created_at DESC, h.id
  LIMIT least(greatest(COALESCE(p_limit, 50), 1), 50)
$fn$;

DO $grants$
DECLARE v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['experience.record_llm_call_metadata(uuid,text,jsonb)',
    'experience.read_llm_call_metadata(uuid[])', 'experience.list_llm_call_metadata_gaps(timestamptz,integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_fn); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', v_fn); END IF;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END
$grants$;

-- Copy every OpenRouter / Venice detail row. A row belongs to its delivered attempt when the identities agree;
-- otherwise (before chat_generation_attempts existed, 2026-10-23) it keeps its own id with attempt_id NULL.
INSERT INTO ops.llm_calls (id, attempt_id, chat_history_id, provider, generation_id, provider_name, model, finish_reason,
  prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, cost_usd, cache_cost_usd, cost_source, latency_ms,
  generation_time_ms, raw_usage, created_at, updated_at)
SELECT COALESCE(a.id, o.id), a.id, o.chat_history_id, 'openrouter', COALESCE(o.llm_generation_id, a.generation_id),
  o.provider_name, o.model, o.finish_reason,
  CASE WHEN o.native_tokens_prompt >= 0 THEN o.native_tokens_prompt END,
  CASE WHEN o.native_tokens_completion >= 0 THEN o.native_tokens_completion END,
  CASE WHEN o.native_tokens_cached >= 0 THEN o.native_tokens_cached END,
  CASE WHEN o.native_tokens_reasoning >= 0 THEN o.native_tokens_reasoning END,
  CASE WHEN jsonb_typeof(o.usage) = 'number' AND (o.usage #>> '{}')::numeric >= 0 THEN (o.usage #>> '{}')::numeric END,
  CASE WHEN jsonb_typeof(o.usage_cache) = 'number' AND (o.usage_cache #>> '{}')::numeric >= 0 THEN (o.usage_cache #>> '{}')::numeric END,
  CASE WHEN jsonb_typeof(o.usage) = 'number' THEN 'openrouter_usage' END,
  CASE WHEN o.latency >= 0 THEN o.latency END, CASE WHEN o.generation_time >= 0 THEN o.generation_time END,
  CASE WHEN jsonb_typeof(o.llm_generation_data) IN ('object', 'array') THEN o.llm_generation_data END,
  o.created_at, o.updated_at
FROM experience.openrouter_chat_history o
LEFT JOIN experience.chat_generation_requests r ON r.chat_history_id = o.chat_history_id
LEFT JOIN experience.chat_generation_attempts a ON a.id = r.delivery_attempt_id AND a.provider = 'openrouter'
  AND (o.llm_generation_id IS NULL OR a.generation_id = o.llm_generation_id)
ON CONFLICT (id) DO NOTHING;

INSERT INTO ops.llm_calls (id, attempt_id, chat_history_id, provider, generation_id, provider_name, model, finish_reason,
  prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, cost_usd, cache_cost_usd, cost_source, latency_ms,
  generation_time_ms, raw_usage, created_at, updated_at)
SELECT COALESCE(a.id, v.id), a.id, v.chat_history_id, 'venice', COALESCE(v.llm_generation_id, a.generation_id),
  v.llm_provider_name, v.llm_model, v.llm_finish_reason,
  CASE WHEN v.llm_native_tokens_prompt >= 0 THEN v.llm_native_tokens_prompt END,
  CASE WHEN v.llm_native_tokens_completion >= 0 THEN v.llm_native_tokens_completion END,
  CASE WHEN v.llm_native_tokens_cached >= 0 THEN v.llm_native_tokens_cached END,
  CASE WHEN v.llm_native_tokens_reasoning >= 0 THEN v.llm_native_tokens_reasoning END,
  CASE WHEN jsonb_typeof(v.llm_usage) = 'number' AND (v.llm_usage #>> '{}')::numeric >= 0 THEN (v.llm_usage #>> '{}')::numeric / 1000000 END,
  CASE WHEN jsonb_typeof(v.llm_usage_cache) = 'number' AND (v.llm_usage_cache #>> '{}')::numeric >= 0 THEN (v.llm_usage_cache #>> '{}')::numeric / 1000000 END,
  CASE WHEN jsonb_typeof(v.llm_usage) = 'number' THEN 'venice_usage' END,
  CASE WHEN v.llm_latency >= 0 THEN v.llm_latency END, CASE WHEN v.llm_generation_time >= 0 THEN v.llm_generation_time END,
  CASE WHEN jsonb_typeof(v.llm_generation_data) IN ('object', 'array') THEN v.llm_generation_data END,
  v.created_at, v.updated_at
FROM experience.venice_chat_history v
LEFT JOIN experience.chat_generation_requests r ON r.chat_history_id = v.chat_history_id
LEFT JOIN experience.chat_generation_attempts a ON a.id = r.delivery_attempt_id AND a.provider = 'venice'
  AND (v.llm_generation_id IS NULL OR a.generation_id = v.llm_generation_id)
ON CONFLICT (id) DO NOTHING;

DO $report$
DECLARE v_or bigint; v_ve bigint; v_ops_or bigint; v_ops_ve bigint;
BEGIN
  SELECT count(*) INTO v_or FROM experience.openrouter_chat_history;
  SELECT count(*) INTO v_ve FROM experience.venice_chat_history;
  SELECT count(*) FILTER (WHERE provider = 'openrouter'), count(*) FILTER (WHERE provider = 'venice')
    INTO v_ops_or, v_ops_ve FROM ops.llm_calls;
  IF v_ops_or < v_or OR v_ops_ve < v_ve THEN
    RAISE EXCEPTION 'p6a2c1: copy incomplete (openrouter %/%, venice %/%)', v_ops_or, v_or, v_ops_ve, v_ve;
  END IF;
  RAISE NOTICE 'p6a2c1 expand: ops.llm_calls openrouter % (detail %), venice % (detail %), attempt-linked %',
    v_ops_or, v_or, v_ops_ve, v_ve, (SELECT count(*) FROM ops.llm_calls WHERE attempt_id IS NOT NULL);
END
$report$;

NOTIFY pgrst, 'reload schema';
COMMIT;
