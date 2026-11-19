-- 数据库重组 6a-2c-2（扩展）：Surplus 调用明细镜像进 ops（后端发布前执行；三个写入函数过渡期不动）。
--
-- 第一段（短事务）：
--   - ops.llm_calls 补列：total_tokens、reported_cost_usd（Surplus 回报的 usage_usd）、capture_status（响应元数据抓取
--     完整度）。成本 cost_usd = buyer_cost_micro ÷ 1e6（我方实付，畅聊视图一直这样换算），cost_source = 'surplus_buyer'。
--   - ops.llm_cost_jobs：上游成本 / 用量的事后补查任务（每次调用一行，外键 → ops.llm_calls，随调用一起清理）。
--     Surplus 请求记录补查的 status / attempts / next_retry_at 迁到这里（kind = 'surplus_request_record'）。
--   - 旧表 experience.surplusintelligence_chat_history 加 AFTER INSERT OR UPDATE 触发器，把每次写入原样镜像到上面两张表
--     （同事务；过渡期旧表仍是写入方的事实来源）。
--   - 两个读 RPC（只读 ops）：read_surplus_call（回读请求参数 / 调用 ID，按需带响应元数据）、
--     list_surplus_request_record_candidates（请求记录补查候选，条件与旧后端一致）。
-- 第二段（只读旧表、只写 ops，不锁旧表）：复制存量；与触发器并发时以触发器的新值为准（ON CONFLICT DO NOTHING）。
-- 可重跑。收缩迁移（三个函数改写 ops、畅聊视图改读 ops、删触发器与旧表）在后端发布、旧读停涨后另起。

BEGIN;
SELECT set_config('lock_timeout', '5s', true);
SELECT set_config('statement_timeout', '60s', true);

ALTER TABLE ops.llm_calls
  ADD COLUMN IF NOT EXISTS total_tokens bigint CHECK (total_tokens IS NULL OR total_tokens >= 0),
  ADD COLUMN IF NOT EXISTS reported_cost_usd numeric CHECK (reported_cost_usd IS NULL OR reported_cost_usd >= 0),
  ADD COLUMN IF NOT EXISTS capture_status text CHECK (capture_status IS NULL OR capture_status IN ('complete', 'partial', 'unavailable'));
CREATE UNIQUE INDEX IF NOT EXISTS llm_calls_surplus_turn_idx ON ops.llm_calls (chat_history_id) WHERE provider = 'surplus';

CREATE TABLE IF NOT EXISTS ops.llm_cost_jobs (
  call_id uuid PRIMARY KEY REFERENCES ops.llm_calls(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('surplus_request_record')),
  status text NOT NULL CHECK (status IN ('pending', 'complete', 'unavailable', 'forbidden', 'not_found')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
  next_retry_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS llm_cost_jobs_due_idx ON ops.llm_cost_jobs (kind, next_retry_at) WHERE status = 'pending';
ALTER TABLE ops.llm_cost_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.llm_cost_jobs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON ops.llm_cost_jobs TO service_role;
COMMENT ON TABLE ops.llm_cost_jobs IS
  '上游调用成本 / 用量的事后补查任务（J）：每次调用一行（call_id → ops.llm_calls，随调用清理）。'
  'surplus_request_record：Surplus 请求记录补查（status / attempts / next_retry_at，30s·2^n 封顶 15 分钟）。';

-- Mirror every write of the old Surplus detail table (the writers' source of truth during the transition).
CREATE OR REPLACE FUNCTION ops.mirror_surplus_call() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE v_id uuid := COALESCE(NEW.attempt_id, NEW.id);
BEGIN
  INSERT INTO ops.llm_calls AS l (id, attempt_id, chat_history_id, provider, generation_id, request_id, provider_name, model,
    finish_reason, call_status, error_code, http_status, prompt_tokens, completion_tokens, total_tokens, cached_tokens,
    reasoning_tokens, cost_usd, reported_cost_usd, cost_source, latency_ms, generation_time_ms, raw_request, raw_usage,
    capture_status, created_at, updated_at)
  VALUES (v_id, NEW.attempt_id, NEW.chat_history_id, 'surplus', NEW.generation_id, NEW.request_id, NEW.provider_name,
    NEW.model, NEW.finish_reason, NEW.call_status, NEW.error_code, NEW.http_status, NEW.prompt_tokens, NEW.completion_tokens,
    NEW.total_tokens, NEW.cached_tokens, NEW.reasoning_tokens, NEW.buyer_cost_micro / 1000000, NEW.usage_usd,
    CASE WHEN NEW.buyer_cost_micro IS NOT NULL THEN 'surplus_buyer' END, NEW.latency_ms, NEW.generation_time_ms,
    NEW.request_parameters, NEW.response_metadata, NEW.metadata_capture_status, NEW.created_at, NEW.updated_at)
  ON CONFLICT (id) DO UPDATE SET attempt_id = EXCLUDED.attempt_id, chat_history_id = EXCLUDED.chat_history_id,
    generation_id = EXCLUDED.generation_id, request_id = EXCLUDED.request_id, provider_name = EXCLUDED.provider_name,
    model = EXCLUDED.model, finish_reason = EXCLUDED.finish_reason, call_status = EXCLUDED.call_status,
    error_code = EXCLUDED.error_code, http_status = EXCLUDED.http_status, prompt_tokens = EXCLUDED.prompt_tokens,
    completion_tokens = EXCLUDED.completion_tokens, total_tokens = EXCLUDED.total_tokens,
    cached_tokens = EXCLUDED.cached_tokens, reasoning_tokens = EXCLUDED.reasoning_tokens, cost_usd = EXCLUDED.cost_usd,
    reported_cost_usd = EXCLUDED.reported_cost_usd, cost_source = EXCLUDED.cost_source, latency_ms = EXCLUDED.latency_ms,
    generation_time_ms = EXCLUDED.generation_time_ms, raw_request = EXCLUDED.raw_request, raw_usage = EXCLUDED.raw_usage,
    capture_status = EXCLUDED.capture_status, updated_at = EXCLUDED.updated_at;
  INSERT INTO ops.llm_cost_jobs AS j (call_id, kind, status, attempts, next_retry_at, updated_at)
  VALUES (v_id, 'surplus_request_record', NEW.request_record_status, NEW.request_record_attempts,
    NEW.request_record_next_retry_at, NEW.updated_at)
  ON CONFLICT (call_id) DO UPDATE SET status = EXCLUDED.status, attempts = EXCLUDED.attempts,
    next_retry_at = EXCLUDED.next_retry_at, updated_at = EXCLUDED.updated_at;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION ops.mirror_surplus_call() FROM PUBLIC;

DROP TRIGGER IF EXISTS mirror_surplus_call ON experience.surplusintelligence_chat_history;
CREATE TRIGGER mirror_surplus_call AFTER INSERT OR UPDATE ON experience.surplusintelligence_chat_history
  FOR EACH ROW EXECUTE FUNCTION ops.mirror_surplus_call();

CREATE OR REPLACE FUNCTION experience.read_surplus_call(p_history_id uuid, p_with_metadata boolean DEFAULT false)
RETURNS TABLE (attempt_id uuid, request_parameters jsonb, generation_id text, response_metadata jsonb)
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $fn$
  SELECT l.attempt_id, l.raw_request, l.generation_id, CASE WHEN p_with_metadata THEN l.raw_usage END
  FROM ops.llm_calls l
  WHERE l.chat_history_id = p_history_id AND l.provider = 'surplus'
$fn$;

CREATE OR REPLACE FUNCTION experience.list_surplus_request_record_candidates(
  p_since timestamptz,
  p_limit integer,
  p_now timestamptz
) RETURNS TABLE (
  chat_history_id uuid,
  request_id text,
  generation_id text,
  call_status text,
  request_record_attempts integer,
  request_record_next_retry_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $fn$
  SELECT l.chat_history_id, l.request_id, l.generation_id, l.call_status, j.attempts, j.next_retry_at
  FROM ops.llm_calls l
  JOIN ops.llm_cost_jobs j ON j.call_id = l.id AND j.kind = 'surplus_request_record'
  WHERE l.provider = 'surplus'
    AND l.request_id IS NOT NULL
    AND j.status = 'pending'
    AND j.attempts < 6
    AND (l.call_status IN ('completed', 'failed', 'interrupted', 'unknown')
      OR (l.call_status IN ('prepared', 'dispatched') AND l.updated_at <= p_now - interval '120 seconds'))
    AND l.created_at >= p_since
    AND (j.next_retry_at IS NULL OR j.next_retry_at <= p_now)
  ORDER BY l.created_at, l.id
  LIMIT least(greatest(COALESCE(p_limit, 50), 1), 50)
$fn$;

DO $grants$
DECLARE v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['experience.read_surplus_call(uuid,boolean)',
    'experience.list_surplus_request_record_candidates(timestamptz,integer,timestamptz)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_fn); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', v_fn); END IF;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END
$grants$;
COMMIT;

-- Copy existing rows. Rows written since the trigger went live are already mirrored with their latest values.
BEGIN;
SELECT set_config('statement_timeout', '300s', true);
INSERT INTO ops.llm_calls (id, attempt_id, chat_history_id, provider, generation_id, request_id, provider_name, model,
  finish_reason, call_status, error_code, http_status, prompt_tokens, completion_tokens, total_tokens, cached_tokens,
  reasoning_tokens, cost_usd, reported_cost_usd, cost_source, latency_ms, generation_time_ms, raw_request, raw_usage,
  capture_status, created_at, updated_at)
SELECT COALESCE(s.attempt_id, s.id), s.attempt_id, s.chat_history_id, 'surplus', s.generation_id, s.request_id,
  s.provider_name, s.model, s.finish_reason, s.call_status, s.error_code, s.http_status, s.prompt_tokens,
  s.completion_tokens, s.total_tokens, s.cached_tokens, s.reasoning_tokens, s.buyer_cost_micro / 1000000, s.usage_usd,
  CASE WHEN s.buyer_cost_micro IS NOT NULL THEN 'surplus_buyer' END, s.latency_ms, s.generation_time_ms,
  s.request_parameters, s.response_metadata, s.metadata_capture_status, s.created_at, s.updated_at
FROM experience.surplusintelligence_chat_history s
ON CONFLICT (id) DO NOTHING;
INSERT INTO ops.llm_cost_jobs (call_id, kind, status, attempts, next_retry_at, updated_at)
SELECT COALESCE(s.attempt_id, s.id), 'surplus_request_record', s.request_record_status, s.request_record_attempts,
  s.request_record_next_retry_at, s.updated_at
FROM experience.surplusintelligence_chat_history s
ON CONFLICT (call_id) DO NOTHING;

DO $report$
DECLARE v_src bigint; v_calls bigint; v_jobs bigint; v_cost_src numeric; v_cost_ops numeric;
BEGIN
  SELECT count(*), sum(buyer_cost_micro) / 1000000 INTO v_src, v_cost_src FROM experience.surplusintelligence_chat_history;
  SELECT count(*), sum(cost_usd) INTO v_calls, v_cost_ops FROM ops.llm_calls WHERE provider = 'surplus';
  SELECT count(*) INTO v_jobs FROM ops.llm_cost_jobs WHERE kind = 'surplus_request_record';
  IF v_calls < v_src OR v_jobs < v_src THEN
    RAISE EXCEPTION 'p6a2c2: copy incomplete (calls %, jobs %, source %)', v_calls, v_jobs, v_src;
  END IF;
  RAISE NOTICE 'p6a2c2 expand: surplus calls % / jobs % (source %), buyer cost USD ops % vs source %',
    v_calls, v_jobs, v_src, v_cost_ops, v_cost_src;
END
$report$;
NOTIFY pgrst, 'reload schema';
COMMIT;
