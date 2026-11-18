-- 数据库重组 6a-1：experience.chat_generation_requests 删 6 个无读者的测速列（不新建表）。
--
-- 删的列：
--   first_token_emitted_ms / client_request_dispatched_ms / client_wait_finished_ms —— 10-29 起后端不写、不上报，全为空；
--   client_first_token_received_ms / client_backgrounded / client_reported_at —— 只被首字视图输出、再被已退役的
--   miniapp_analytics.chat_first_token_report 读；客户端首字、渲染延迟、切后台已由 Faro roleplay.first_token /
--   roleplay.render 记录。
-- 门禁、交付仲裁、取消都不读这 6 列；report_chat_first_token 判断"是否在后台"用本次上报参数，不读列。
-- 留下的 primary_timeout_ms / timeout_rate_target / fallback_timeout_ms 是开轮冻结的请求参数（fallback_timeout_ms
-- 参与开轮重放身份校验），fallback_triggered_ms 是畅聊模型评估的输入。
--
-- 做什么（一个事务、一个 DO 块，锁内一次往返）：
--   1. 守卫：report_chat_first_token 里要改的那段原文恰好一次（已改过则跳过）；首字视图输出列与生产 11-19 一致
--      （已是新形状则跳过），依赖它的只有 free_zone_turn_facts；两个视图属主是当前用户。
--   2. 改动前对首字视图算指纹（1 天内、1 小时以前的行，保留列）。
--   3. 改 report_chat_first_token（按原文替换 UPDATE 的列清单，pg_get_functiondef 改写，保留 OID/属主/授权）→
--      删 chat_first_token_report → 删两个视图（只锁视图本身；不用 LOCK 视图，PG11 起那会把 chat_history 等基表一并
--      排他锁住）→ 锁请求表（lock_timeout 5s）→ 重建两个视图（首字视图去掉 7 个输出列，授权与 reloptions 照旧）→
--      删 6 列 → 指纹必须一致 → 没有函数正文再引用这 6 个列名。
-- 可重跑：已完成时只打印 NOTICE。

BEGIN;
SELECT set_config('lock_timeout', '5s', true);
SELECT set_config('statement_timeout', '60s', true);

DO $p6a1$
DECLARE
  v_report regprocedure := 'experience.report_chat_first_token(uuid,uuid,jsonb)'::regprocedure;
  v_report_old text := $old$    client_request_dispatched_ms=(p_report->>'request_dispatched_ms')::numeric,
    client_first_token_received_ms=(p_report->>'first_token_received_ms')::numeric,
    client_backgrounded=(p_report->>'backgrounded')::boolean,measurement_method=p_report->>'measurement_method',
    client_wait_finished_ms=(p_report->>'wait_finished_ms')::numeric,
    client_reason=v_reason,client_reported_at=clock_timestamp()
$old$;
  v_report_new text := $new$    measurement_method=p_report->>'measurement_method',client_reason=v_reason
$new$;
  v_dropped text[] := ARRAY['first_token_emitted_ms','client_request_dispatched_ms','client_wait_finished_ms',
    'client_first_token_received_ms','client_backgrounded','client_reported_at'];
  v_facts_old_cols text[] := ARRAY['chat_history_id','request_received_at','requested_model_id','requested_provider',
    'requested_provider_model_id','catalog_version','client_reason','measurement_method','primary_timeout_ms',
    'first_token_deadline_ms','timeout_rate_target','mode','fallback_started','delivery_role','billing_rejected',
    'server_first_token_timeout','client_outcome','client_first_token_visible_ms','client_backgrounded',
    'client_request_dispatched_ms','client_first_token_received_ms','first_token_emitted_ms','primary_wait_ms',
    'fallback_dispatch_delay_ms','primary_dispatch_offset_ms','primary_headers_ms','primary_first_chunk_ms',
    'fallback_dispatch_offset_ms','fallback_headers_ms','fallback_first_chunk_ms','primary_provider_name',
    'fallback_provider_name','primary_provider_reported_model','fallback_provider_reported_model',
    'primary_provider_latency_scope','fallback_provider_latency_scope','primary_actual_first_token_ms',
    'fallback_first_token_ms','primary_observed_until_ms','primary_end_reason','fallback_end_reason',
    'primary_provider_latency_ms','fallback_provider_latency_ms','primary_provider_gap_ms','fallback_provider_gap_ms',
    'client_server_residual_ms','client_display_delay_ms','business_status','business_finish_reason',
    'fallback_model_id','fallback_timeout_ms','client_wait_finished_ms','server_timeout_stage','recoverable_delivery',
    'server_first_token_ready_ms','client_delivery_failed'];
  v_facts_removed text[] := ARRAY['client_backgrounded','client_request_dispatched_ms','client_first_token_received_ms',
    'first_token_emitted_ms','client_server_residual_ms','client_display_delay_ms','client_wait_finished_ms'];
  v_turn_cols text[] := ARRAY['chat_history_id','turn_at','model_id','served_provider','primary_output',
    'fallback_delivered','timed_out','primary_ttft_ms','refused','truncated','buyer_cost_usd','prompt_tokens',
    'cached_tokens','primary_delivered','interrupted'];
  v_facts_new_cols text[];
  v_facts_cols text[];
  v_turn_cur text[];
  v_def text;
  v_report_todo boolean;
  v_views_todo boolean;
  v_cols_todo boolean;
  v_grants text[];
  v_g text;
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
  v_def := pg_get_functiondef(v_report);
  v_report_todo := position(v_report_old IN v_def) > 0;
  IF v_report_todo AND cardinality(string_to_array(v_def, v_report_old)) <> 2 THEN
    RAISE EXCEPTION 'p6a1: report_chat_first_token anchor must match exactly once';
  END IF;
  IF NOT v_report_todo AND v_def ~ ('\m(' || array_to_string(v_dropped, '|') || ')\M') THEN
    RAISE EXCEPTION 'p6a1: report_chat_first_token drifted (anchor missing but dropped columns still referenced)';
  END IF;

  SELECT array_agg(attname::text ORDER BY attnum) INTO v_facts_cols FROM pg_attribute
  WHERE attrelid = 'miniapp_analytics.chat_first_token_facts'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_facts_cols = v_facts_old_cols THEN v_views_todo := true;
  ELSIF v_facts_cols = v_facts_new_cols THEN v_views_todo := false;
  ELSE RAISE EXCEPTION 'p6a1: chat_first_token_facts columns differ from production 2026-11-19: %', v_facts_cols;
  END IF;
  SELECT array_agg(attname::text ORDER BY attnum) INTO v_turn_cur FROM pg_attribute
  WHERE attrelid = 'miniapp_analytics.free_zone_turn_facts'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_turn_cur IS DISTINCT FROM v_turn_cols THEN
    RAISE EXCEPTION 'p6a1: free_zone_turn_facts columns differ from production 2026-11-19: %', v_turn_cur;
  END IF;
  SELECT string_agg(DISTINCT v.oid::regclass::text, ', ') INTO v_bad
  FROM pg_depend d JOIN pg_rewrite rw ON rw.oid = d.objid JOIN pg_class v ON v.oid = rw.ev_class
  WHERE d.classid = 'pg_rewrite'::regclass AND d.refobjid = 'miniapp_analytics.chat_first_token_facts'::regclass
    AND v.oid NOT IN ('miniapp_analytics.chat_first_token_facts'::regclass, 'miniapp_analytics.free_zone_turn_facts'::regclass);
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'p6a1: unexpected dependents of chat_first_token_facts: %', v_bad; END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN ('miniapp_analytics.chat_first_token_facts'::regclass,
      'miniapp_analytics.free_zone_turn_facts'::regclass) AND relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'p6a1: analytics views must be owned by %', current_user;
  END IF;

  SELECT count(*) > 0 INTO v_cols_todo FROM pg_attribute
  WHERE attrelid = 'experience.chat_generation_requests'::regclass AND attname = ANY (v_dropped) AND NOT attisdropped;

  IF NOT v_report_todo AND NOT v_views_todo AND NOT v_cols_todo
     AND to_regprocedure('miniapp_analytics.chat_first_token_report(timestamptz,timestamptz)') IS NULL THEN
    RAISE NOTICE 'p6a1: already applied, nothing to do';
    RETURN;
  END IF;

  -- Fingerprint of the kept view columns over settled rows (1 day old .. 1 hour old).
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
  IF v_report_todo THEN
    EXECUTE replace(v_def, v_report_old, v_report_new);
  END IF;

  DROP FUNCTION IF EXISTS miniapp_analytics.chat_first_token_report(timestamptz, timestamptz);

  -- Views first (their own lock only; readers take the view lock before base tables), then the request table.
  IF v_views_todo THEN
    DROP VIEW miniapp_analytics.free_zone_turn_facts;
    DROP VIEW miniapp_analytics.chat_first_token_facts;
  END IF;
  LOCK TABLE experience.chat_generation_requests IN ACCESS EXCLUSIVE MODE;

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
      p.headers_ms AS primary_headers_ms,
      p.first_chunk_ms AS primary_first_chunk_ms,
      f.dispatch_offset_ms AS fallback_dispatch_offset_ms,
      f.headers_ms AS fallback_headers_ms,
      f.first_chunk_ms AS fallback_first_chunk_ms,
      p.provider_name AS primary_provider_name,
      f.provider_name AS fallback_provider_name,
      p.provider_reported_model AS primary_provider_reported_model,
      f.provider_reported_model AS fallback_provider_reported_model,
      p.provider_latency_scope AS primary_provider_latency_scope,
      f.provider_latency_scope AS fallback_provider_latency_scope,
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
      p.provider_latency_ms AS primary_provider_latency_ms,
      f.provider_latency_ms AS fallback_provider_latency_ms,
      (p.first_token_ms - p.provider_latency_ms) AS primary_provider_gap_ms,
      (f.first_token_ms - f.provider_latency_ms) AS fallback_provider_gap_ms,
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
    ALTER TABLE experience.chat_generation_requests
      DROP COLUMN IF EXISTS first_token_emitted_ms,
      DROP COLUMN IF EXISTS client_request_dispatched_ms,
      DROP COLUMN IF EXISTS client_wait_finished_ms,
      DROP COLUMN IF EXISTS client_first_token_received_ms,
      DROP COLUMN IF EXISTS client_backgrounded,
      DROP COLUMN IF EXISTS client_reported_at;
  END IF;

  -- ── guard_after ──
  EXECUTE v_fp_sql INTO v_fp_after USING v_from, v_to;
  IF v_fp_after IS DISTINCT FROM v_fp_before THEN
    RAISE EXCEPTION 'p6a1: chat_first_token_facts kept columns changed (before %, after %)', v_fp_before, v_fp_after;
  END IF;
  SELECT array_agg(attname::text ORDER BY attnum) INTO v_facts_cols FROM pg_attribute
  WHERE attrelid = 'miniapp_analytics.chat_first_token_facts'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_facts_cols IS DISTINCT FROM v_facts_new_cols THEN
    RAISE EXCEPTION 'p6a1: rebuilt chat_first_token_facts has unexpected columns: %', v_facts_cols;
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prokind IN ('f', 'p')
    AND p.prosrc ~ ('\m(' || array_to_string(v_dropped, '|') || ')\M');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'p6a1: functions still reference dropped request columns: %', v_bad;
  END IF;

  RAISE NOTICE 'p6a1: report patched=%, views rebuilt=%, columns dropped=%, fingerprint=%',
    v_report_todo, v_views_todo, v_cols_todo, v_fp_after;
END
$p6a1$;

NOTIFY pgrst, 'reload schema';
COMMIT;
