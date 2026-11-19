-- 数据库重组 6a-2a：experience.chat_generation_attempts 删 7 个无读者的列（后端发布、旧写入停涨之后执行）。
--
-- 删的列：headers_ms / first_chunk_ms / http_status / provider_latency_ms / provider_latency_scope（恒为同一值）/
--   provider_name / provider_reported_model。只被 chat_first_token_facts 输出、那些输出列已无读者（首字报告函数 6a-1
--   已删）；首包/首块耗时已由 OTel observeGenerationAttempt 记录，供应商名/延迟/型号与 OpenRouter 明细重复。
-- 留下：调用身份（id/role/provider/provider_model_id/generation_id/dispatched_at/end_reason/finish_reason/updated_at）、
--   畅聊模型评估与 Grafana 01 读的 dispatch_offset_ms / first_token_ms / observed_until_ms、落败快照 discarded_response
--   （6a-2c 随明细迁 ops）。
--
-- 做什么（一个事务、一个 DO 块）：
--   1. 守卫：observe_chat_generation_attempt 三段原文各恰好一次（全部已改则跳过）；首字视图输出列与 6a-1 后一致
--      （已是新形状则跳过），依赖它的只有 free_zone_turn_facts；两个视图属主是当前用户。
--   2. 改动前对首字视图算指纹（1 天内、1 小时以前的行，保留列）。
--   3. 改 observe（删 6 行赋值）→ 删两个视图（不 LOCK 视图，PG11 起会递归锁基表）→ 锁 attempts（lock_timeout 5s）→
--      重建两个视图（首字视图去掉 14 个输出列，授权与 reloptions 照旧）→ 删 7 列 → 指纹一致 → 没有函数再引用这些列。
-- 可重跑：已完成时只打印 NOTICE。

BEGIN;
SELECT set_config('lock_timeout', '5s', true);
SELECT set_config('statement_timeout', '60s', true);

DO $p6a2a$
DECLARE
  v_observe regprocedure := 'experience.observe_chat_generation_attempt(uuid,jsonb)'::regprocedure;
  v_old text[] := ARRAY[
$a1$    headers_ms=COALESCE(headers_ms,(p_observation->>'headers_ms')::numeric),
    first_chunk_ms=COALESCE(first_chunk_ms,(p_observation->>'first_chunk_ms')::numeric),
$a1$,
$a2$    http_status=COALESCE(http_status,(p_observation->>'http_status')::integer),
$a2$,
$a3$    provider_latency_ms=COALESCE(provider_latency_ms,(p_observation->>'provider_latency_ms')::numeric),
    provider_name=COALESCE(provider_name,left(p_observation->>'provider_name',512)),
    provider_reported_model=COALESCE(provider_reported_model,left(p_observation->>'provider_reported_model',512)),
$a3$];
  v_dropped text[] := ARRAY['headers_ms','first_chunk_ms','http_status','provider_latency_ms','provider_latency_scope',
    'provider_name','provider_reported_model'];
  -- Names unique to this table (http_status / provider_name also live on the Surplus detail table).
  v_unique text[] := ARRAY['headers_ms','first_chunk_ms','provider_latency_ms','provider_latency_scope','provider_reported_model'];
  v_facts_old_cols text[] := ARRAY['chat_history_id','request_received_at','requested_model_id','requested_provider',
    'requested_provider_model_id','catalog_version','client_reason','measurement_method','primary_timeout_ms',
    'first_token_deadline_ms','timeout_rate_target','mode','fallback_started','delivery_role','billing_rejected',
    'server_first_token_timeout','client_outcome','client_first_token_visible_ms','primary_wait_ms',
    'fallback_dispatch_delay_ms','primary_dispatch_offset_ms','primary_headers_ms','primary_first_chunk_ms',
    'fallback_dispatch_offset_ms','fallback_headers_ms','fallback_first_chunk_ms','primary_provider_name',
    'fallback_provider_name','primary_provider_reported_model','fallback_provider_reported_model',
    'primary_provider_latency_scope','fallback_provider_latency_scope','primary_actual_first_token_ms',
    'fallback_first_token_ms','primary_observed_until_ms','primary_end_reason','fallback_end_reason',
    'primary_provider_latency_ms','fallback_provider_latency_ms','primary_provider_gap_ms','fallback_provider_gap_ms',
    'business_status','business_finish_reason','fallback_model_id','fallback_timeout_ms','server_timeout_stage',
    'recoverable_delivery','server_first_token_ready_ms','client_delivery_failed'];
  v_facts_removed text[] := ARRAY['primary_headers_ms','primary_first_chunk_ms','fallback_headers_ms',
    'fallback_first_chunk_ms','primary_provider_name','fallback_provider_name','primary_provider_reported_model',
    'fallback_provider_reported_model','primary_provider_latency_scope','fallback_provider_latency_scope',
    'primary_provider_latency_ms','fallback_provider_latency_ms','primary_provider_gap_ms','fallback_provider_gap_ms'];
  v_turn_cols text[] := ARRAY['chat_history_id','turn_at','model_id','served_provider','primary_output',
    'fallback_delivered','timed_out','primary_ttft_ms','refused','truncated','buyer_cost_usd','prompt_tokens',
    'cached_tokens','primary_delivered','interrupted'];
  v_facts_new_cols text[];
  v_facts_cols text[];
  v_turn_cur text[];
  v_def text;
  v_hits int;
  v_observe_todo boolean;
  v_views_todo boolean;
  v_cols_todo boolean;
  v_grants text[];
  v_g text;
  v_i int;
  v_fp_before text;
  v_fp_after text;
  v_fp_sql text;
  v_from timestamptz := clock_timestamp() - interval '1 day';
  v_to timestamptz := clock_timestamp() - interval '1 hour';
  v_bad text;
BEGIN
  SELECT array_agg(c ORDER BY o) INTO v_facts_new_cols
  FROM unnest(v_facts_old_cols) WITH ORDINALITY AS u(c, o) WHERE c <> ALL (v_facts_removed);

  -- ── guard_before_lock ──
  v_def := pg_get_functiondef(v_observe);
  v_hits := 0;
  FOR v_i IN 1 .. cardinality(v_old) LOOP
    IF position(v_old[v_i] IN v_def) > 0 THEN
      IF cardinality(string_to_array(v_def, v_old[v_i])) <> 2 THEN
        RAISE EXCEPTION 'p6a2a: observe anchor % must match exactly once', v_i;
      END IF;
      v_hits := v_hits + 1;
    END IF;
  END LOOP;
  IF v_hits NOT IN (0, cardinality(v_old)) THEN
    RAISE EXCEPTION 'p6a2a: observe_chat_generation_attempt drifted (% of % anchors found)', v_hits, cardinality(v_old);
  END IF;
  v_observe_todo := v_hits > 0;
  IF NOT v_observe_todo AND v_def ~ ('\m(' || array_to_string(v_dropped, '|') || ')\M') THEN
    RAISE EXCEPTION 'p6a2a: observe_chat_generation_attempt drifted (anchors missing but dropped columns still referenced)';
  END IF;

  SELECT array_agg(attname::text ORDER BY attnum) INTO v_facts_cols FROM pg_attribute
  WHERE attrelid = 'miniapp_analytics.chat_first_token_facts'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_facts_cols = v_facts_old_cols THEN v_views_todo := true;
  ELSIF v_facts_cols = v_facts_new_cols THEN v_views_todo := false;
  ELSE RAISE EXCEPTION 'p6a2a: chat_first_token_facts columns differ from the 6a-1 shape: %', v_facts_cols;
  END IF;
  SELECT array_agg(attname::text ORDER BY attnum) INTO v_turn_cur FROM pg_attribute
  WHERE attrelid = 'miniapp_analytics.free_zone_turn_facts'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_turn_cur IS DISTINCT FROM v_turn_cols THEN
    RAISE EXCEPTION 'p6a2a: free_zone_turn_facts columns differ from production 2026-11-19: %', v_turn_cur;
  END IF;
  SELECT string_agg(DISTINCT v.oid::regclass::text, ', ') INTO v_bad
  FROM pg_depend d JOIN pg_rewrite rw ON rw.oid = d.objid JOIN pg_class v ON v.oid = rw.ev_class
  WHERE d.classid = 'pg_rewrite'::regclass AND d.refobjid = 'miniapp_analytics.chat_first_token_facts'::regclass
    AND v.oid NOT IN ('miniapp_analytics.chat_first_token_facts'::regclass, 'miniapp_analytics.free_zone_turn_facts'::regclass);
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'p6a2a: unexpected dependents of chat_first_token_facts: %', v_bad; END IF;
  SELECT string_agg(DISTINCT v.oid::regclass::text, ', ') INTO v_bad
  FROM pg_depend d JOIN pg_rewrite rw ON rw.oid = d.objid JOIN pg_class v ON v.oid = rw.ev_class
  WHERE d.classid = 'pg_rewrite'::regclass AND d.refobjid = 'experience.chat_generation_attempts'::regclass
    AND v.oid <> 'miniapp_analytics.chat_first_token_facts'::regclass;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'p6a2a: unexpected views over chat_generation_attempts: %', v_bad; END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN ('miniapp_analytics.chat_first_token_facts'::regclass,
      'miniapp_analytics.free_zone_turn_facts'::regclass) AND relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'p6a2a: analytics views must be owned by %', current_user;
  END IF;

  SELECT count(*) > 0 INTO v_cols_todo FROM pg_attribute
  WHERE attrelid = 'experience.chat_generation_attempts'::regclass AND attname = ANY (v_dropped) AND NOT attisdropped;

  IF NOT v_observe_todo AND NOT v_views_todo AND NOT v_cols_todo THEN
    RAISE NOTICE 'p6a2a: already applied, nothing to do';
    RETURN;
  END IF;

  v_fp_sql := format($fp$SELECT count(*)::text || ':' || COALESCE(md5(string_agg(t::text, '|' ORDER BY t.chat_history_id)), '')
    FROM (SELECT %s FROM miniapp_analytics.chat_first_token_facts WHERE request_received_at >= $1 AND request_received_at < $2) t$fp$,
    (SELECT string_agg(quote_ident(c), ',' ORDER BY o) FROM unnest(v_facts_new_cols) WITH ORDINALITY AS u(c, o)));
  EXECUTE v_fp_sql INTO v_fp_before USING v_from, v_to;

  SELECT array_agg(format('GRANT %s ON %s TO %s', a.privilege_type, c.oid::regclass,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END))
    INTO v_grants
  FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE c.oid IN ('miniapp_analytics.chat_first_token_facts'::regclass, 'miniapp_analytics.free_zone_turn_facts'::regclass)
    AND a.grantee <> c.relowner;

  -- ── locked section ──
  IF v_observe_todo THEN
    FOR v_i IN 1 .. cardinality(v_old) LOOP
      v_def := replace(v_def, v_old[v_i], '');
    END LOOP;
    EXECUTE v_def;
  END IF;

  -- Views first (their own lock only; readers take the view lock before base tables), then the attempt table.
  IF v_views_todo THEN
    DROP VIEW miniapp_analytics.free_zone_turn_facts;
    DROP VIEW miniapp_analytics.chat_first_token_facts;
  END IF;
  LOCK TABLE experience.chat_generation_attempts IN ACCESS EXCLUSIVE MODE;

  IF v_views_todo THEN
    CREATE VIEW miniapp_analytics.chat_first_token_facts WITH (security_invoker = false) AS
    SELECT r.chat_history_id,
      r.request_received_at,
      r.requested_model_id,
      r.requested_provider,
      r.requested_provider_model_id,
      r.catalog_version,
      r.client_reason,
      r.measurement_method,
      r.primary_timeout_ms,
      r.first_token_deadline_ms,
      r.timeout_rate_target,
      r.mode,
      (r.fallback_triggered_ms IS NOT NULL) AS fallback_started,
      d.role AS delivery_role,
      r.billing_rejected,
      r.first_token_timeout AS server_first_token_timeout,
      r.client_outcome,
      r.client_first_token_visible_ms,
      CASE
        WHEN r.fallback_triggered_ms IS NOT NULL THEN r.fallback_triggered_ms - p.dispatch_offset_ms
        ELSE p.first_token_ms
      END AS primary_wait_ms,
      (f.dispatch_offset_ms - r.fallback_triggered_ms) AS fallback_dispatch_delay_ms,
      p.dispatch_offset_ms AS primary_dispatch_offset_ms,
      f.dispatch_offset_ms AS fallback_dispatch_offset_ms,
      p.first_token_ms AS primary_actual_first_token_ms,
      f.first_token_ms AS fallback_first_token_ms,
      p.observed_until_ms AS primary_observed_until_ms,
      COALESCE(p.end_reason,
        CASE
          WHEN p.dispatched_at IS NULL THEN 'not_dispatched'::text
          WHEN r.request_received_at < (statement_timestamp() - '00:01:50'::interval) THEN 'unknown'::text
          ELSE 'pending'::text
        END) AS primary_end_reason,
      f.end_reason AS fallback_end_reason,
      h.status AS business_status,
      h.llm_finish_reason AS business_finish_reason,
      r.fallback_model_id,
      r.fallback_timeout_ms,
      r.server_timeout_stage,
      r.recoverable_delivery,
      r.server_first_token_ready_ms,
      r.client_delivery_failed
    FROM experience.chat_generation_requests r
    JOIN experience.chat_history h ON h.id = r.chat_history_id
    LEFT JOIN experience.chat_generation_attempts p ON p.chat_history_id = r.chat_history_id AND p.role = 'primary'::text
    LEFT JOIN experience.chat_generation_attempts f ON f.chat_history_id = r.chat_history_id AND f.role = 'fallback'::text
    LEFT JOIN experience.chat_generation_attempts d ON d.id = r.delivery_attempt_id;

    CREATE VIEW miniapp_analytics.free_zone_turn_facts AS
    SELECT f.chat_history_id,
      f.request_received_at AS turn_at,
      f.requested_model_id AS model_id,
      s.provider_name AS served_provider,
      (f.primary_actual_first_token_ms IS NOT NULL) AS primary_output,
      (f.delivery_role = 'fallback'::text) AS fallback_delivered,
      COALESCE(f.server_first_token_timeout, false) AS timed_out,
      f.primary_actual_first_token_ms AS primary_ttft_ms,
      (f.business_finish_reason = 'content_filter'::text) AS refused,
      (f.business_finish_reason = 'length'::text) AS truncated,
      (s.buyer_cost_micro / 1000000.0) AS buyer_cost_usd,
      s.prompt_tokens,
      s.cached_tokens,
      COALESCE(f.delivery_role = 'primary'::text, false) AS primary_delivered,
      COALESCE(f.delivery_role = 'primary'::text AND f.business_status = 'stream_interrupted'::text
        AND COALESCE(f.business_finish_reason, ''::text) <> ALL (ARRAY['user_cancelled'::text, 'content_filter'::text]),
        false) AS interrupted
    FROM miniapp_analytics.chat_first_token_facts f
    LEFT JOIN experience.surplusintelligence_chat_history s ON s.chat_history_id = f.chat_history_id
    WHERE f.requested_model_id ~~ 'free-%'::text;

    FOREACH v_g IN ARRAY COALESCE(v_grants, ARRAY[]::text[]) LOOP
      EXECUTE v_g;
    END LOOP;
  END IF;

  IF v_cols_todo THEN
    ALTER TABLE experience.chat_generation_attempts
      DROP COLUMN IF EXISTS headers_ms,
      DROP COLUMN IF EXISTS first_chunk_ms,
      DROP COLUMN IF EXISTS http_status,
      DROP COLUMN IF EXISTS provider_latency_ms,
      DROP COLUMN IF EXISTS provider_latency_scope,
      DROP COLUMN IF EXISTS provider_name,
      DROP COLUMN IF EXISTS provider_reported_model;
  END IF;

  -- ── guard_after ──
  EXECUTE v_fp_sql INTO v_fp_after USING v_from, v_to;
  IF v_fp_after IS DISTINCT FROM v_fp_before THEN
    RAISE EXCEPTION 'p6a2a: chat_first_token_facts kept columns changed (before %, after %)', v_fp_before, v_fp_after;
  END IF;
  SELECT array_agg(attname::text ORDER BY attnum) INTO v_facts_cols FROM pg_attribute
  WHERE attrelid = 'miniapp_analytics.chat_first_token_facts'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_facts_cols IS DISTINCT FROM v_facts_new_cols THEN
    RAISE EXCEPTION 'p6a2a: rebuilt chat_first_token_facts has unexpected columns: %', v_facts_cols;
  END IF;
  IF pg_get_functiondef(v_observe) ~ ('\m(' || array_to_string(v_dropped, '|') || ')\M') THEN
    RAISE EXCEPTION 'p6a2a: observe_chat_generation_attempt still references dropped columns';
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prokind IN ('f', 'p')
    AND p.prosrc ~ ('\m(' || array_to_string(v_unique, '|') || ')\M');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'p6a2a: functions still reference dropped attempt columns: %', v_bad;
  END IF;

  RAISE NOTICE 'p6a2a: observe patched=%, views rebuilt=%, columns dropped=%, fingerprint=%',
    v_observe_todo, v_views_todo, v_cols_todo, v_fp_after;
END
$p6a2a$;

NOTIFY pgrst, 'reload schema';
COMMIT;
