-- Domain: miniapp_features（畅聊栏目的上下架运行状态）+ miniapp_analytics 只读投影
--         + admin managed config key `free_zone_config`.
--
-- 畅聊（免费模型）栏目：候选模型由运营配置维护，后台评估任务每 30 分钟按
-- 「Surplus 官方数据初筛 + 在架真实业务数据」决定上架/下架，结果落在：
--   1) miniapp_features.free_zone_models：每个候选一行，当前状态（唯一写入方：后端评估任务）
--   2) miniapp_features.free_zone_events：只追加的上下架记录，用于复盘
--   3) miniapp_analytics.free_zone_*：给评估任务与 Grafana 共用的只读视图，口径只定义一份
--   4) free_zone_config 运营 managed key（字段规则在 shared zod；库里只保证是 JSON 对象）
--
-- 这些对象随功能下线可以整体删除，不是多个领域共用的根数据，所以归 miniapp_features。
-- 不建跨 schema 外键：候选 id 来自运营配置。视图只读 experience 的事实表，不写。
-- 执行顺序：TEST → 生产；先迁移、再部署后端（总开关默认关）、再前端、最后发布运营配置。
-- 回滚：关运营总开关即可让栏目消失；如需删除对象，先下线后端评估任务，再
--   DROP VIEW miniapp_analytics.free_zone_*; DROP TABLE miniapp_features.free_zone_*;
--   managed key 的函数链保留（对未知 key 仍然拒绝），不影响其他配置。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── 1. 运行状态 ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS miniapp_features.free_zone_models (
  candidate_id text PRIMARY KEY
    CONSTRAINT free_zone_models_candidate_check
    CHECK (length(candidate_id) <= 64 AND candidate_id ~ '^free-[a-z0-9]([a-z0-9._-]*[a-z0-9])?$'),
  surplus_model text NOT NULL
    CONSTRAINT free_zone_models_surplus_model_check CHECK (length(surplus_model) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'unlisted'
    CONSTRAINT free_zone_models_status_check CHECK (status IN ('unlisted', 'listed', 'cooling')),
  providers text[] NOT NULL DEFAULT '{}'
    CONSTRAINT free_zone_models_providers_check
    CHECK (cardinality(providers) <= 5 AND array_position(providers, NULL) IS NULL),
  provider_since timestamptz,
  excluded_providers jsonb NOT NULL DEFAULT '{}'
    CONSTRAINT free_zone_models_excluded_check
    CHECK (jsonb_typeof(excluded_providers) = 'object' AND pg_column_size(excluded_providers) <= 8192),
  consecutive_passes integer NOT NULL DEFAULT 0
    CONSTRAINT free_zone_models_passes_check CHECK (consecutive_passes >= 0),
  cooldown_until timestamptz,
  business_delists_at timestamptz[] NOT NULL DEFAULT '{}'
    CONSTRAINT free_zone_models_delists_check CHECK (cardinality(business_delists_at) <= 50),
  last_reason text CONSTRAINT free_zone_models_reason_check CHECK (length(last_reason) <= 2000),
  last_metrics jsonb NOT NULL DEFAULT '{}'
    CONSTRAINT free_zone_models_metrics_check
    CHECK (jsonb_typeof(last_metrics) = 'object' AND pg_column_size(last_metrics) <= 65536),
  evaluated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT free_zone_models_listed_providers_check
    CHECK (status <> 'listed' OR cardinality(providers) >= 1),
  CONSTRAINT free_zone_models_cooling_check
    CHECK (status <> 'cooling' OR cooldown_until IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS miniapp_features.free_zone_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  candidate_id text NOT NULL CONSTRAINT free_zone_events_candidate_check CHECK (length(candidate_id) <= 64),
  event_type text NOT NULL
    CONSTRAINT free_zone_events_type_check
    CHECK (event_type IN ('listed', 'provider_switched', 'delisted', 'cooldown_ended')),
  cause text CONSTRAINT free_zone_events_cause_check CHECK (cause IN ('official', 'business')),
  providers text[] NOT NULL DEFAULT '{}',
  reason text CONSTRAINT free_zone_events_reason_check CHECK (length(reason) <= 2000),
  metrics jsonb NOT NULL DEFAULT '{}'
    CONSTRAINT free_zone_events_metrics_check
    CHECK (jsonb_typeof(metrics) = 'object' AND pg_column_size(metrics) <= 65536),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS free_zone_events_candidate_created_idx
  ON miniapp_features.free_zone_events (candidate_id, created_at DESC);

ALTER TABLE miniapp_features.free_zone_models OWNER TO postgres;
ALTER TABLE miniapp_features.free_zone_events OWNER TO postgres;
ALTER TABLE miniapp_features.free_zone_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp_features.free_zone_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp_features.free_zone_models, miniapp_features.free_zone_events
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON miniapp_features.free_zone_models TO service_role, postgres;
GRANT SELECT, INSERT ON miniapp_features.free_zone_events TO service_role, postgres;
COMMENT ON TABLE miniapp_features.free_zone_models IS
  '畅聊候选模型当前上下架状态。唯一写入方：后端评估任务；线上读路径只读并在进程内缓存。';
COMMENT ON COLUMN miniapp_features.free_zone_models.providers IS
  '当前在用的 Surplus 供应商（在架时恰好一家，选定后一直用以保缓存命中；不达标才顺延到下一家）。';
COMMENT ON TABLE miniapp_features.free_zone_events IS
  '畅聊候选模型的上下架/冷却到期记录，只追加，带当时的原因与指标快照。';

-- ── 2. 只读投影（评估任务与 Grafana 共用一份口径）─────────────────────────────

-- 每个免费模型轮次一行。主模型是 Surplus，兜底是 OpenRouter 的 1017，所以
-- surplusintelligence_chat_history 里这一轮的行就是主模型那次调用。
CREATE OR REPLACE VIEW miniapp_analytics.free_zone_turn_facts AS
SELECT
  f.chat_history_id,
  f.request_received_at AS turn_at,
  f.requested_model_id AS model_id,
  s.provider_name AS served_provider,
  f.primary_actual_first_token_ms IS NOT NULL AS primary_output,
  f.delivery_role = 'fallback' AS fallback_delivered,
  COALESCE(f.server_first_token_timeout, false) AS timed_out,
  f.primary_actual_first_token_ms AS primary_ttft_ms,
  f.business_finish_reason = 'content_filter' AS refused,
  f.business_finish_reason = 'length' AS truncated,
  s.buyer_cost_micro / 1000000.0 AS buyer_cost_usd,
  s.prompt_tokens,
  s.cached_tokens
FROM miniapp_analytics.chat_first_token_facts f
LEFT JOIN experience.surplusintelligence_chat_history s ON s.chat_history_id = f.chat_history_id
WHERE f.requested_model_id LIKE 'free-%';

CREATE OR REPLACE VIEW miniapp_analytics.free_zone_dislikes AS
SELECT created_at, model_id
FROM experience.chat_reply_feedback
WHERE model_id LIKE 'free-%';

CREATE OR REPLACE VIEW miniapp_analytics.free_zone_model_states AS
SELECT candidate_id, surplus_model, status, providers, provider_since, excluded_providers,
  consecutive_passes, cooldown_until, last_reason, last_metrics, evaluated_at, updated_at
FROM miniapp_features.free_zone_models;

CREATE OR REPLACE VIEW miniapp_analytics.free_zone_model_events AS
SELECT id, candidate_id, event_type, cause, providers, reason, metrics, created_at
FROM miniapp_features.free_zone_events;

ALTER VIEW miniapp_analytics.free_zone_turn_facts OWNER TO postgres;
ALTER VIEW miniapp_analytics.free_zone_dislikes OWNER TO postgres;
ALTER VIEW miniapp_analytics.free_zone_model_states OWNER TO postgres;
ALTER VIEW miniapp_analytics.free_zone_model_events OWNER TO postgres;
REVOKE ALL ON miniapp_analytics.free_zone_turn_facts, miniapp_analytics.free_zone_dislikes,
  miniapp_analytics.free_zone_model_states, miniapp_analytics.free_zone_model_events
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON miniapp_analytics.free_zone_turn_facts, miniapp_analytics.free_zone_dislikes,
  miniapp_analytics.free_zone_model_states, miniapp_analytics.free_zone_model_events
  TO service_role, postgres;
DO $grafana$
BEGIN
  -- Grafana 通过既有的指标只读角色访问；TEST 里没有这个角色时跳过。
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'first_token_metrics_reader') THEN
    GRANT SELECT ON miniapp_analytics.free_zone_turn_facts, miniapp_analytics.free_zone_dislikes,
      miniapp_analytics.free_zone_model_states, miniapp_analytics.free_zone_model_events
      TO first_token_metrics_reader;
  END IF;
END
$grafana$;

-- ── 3. 运营 managed key ──────────────────────────────────────────────────────

DO $extend_functions$
DECLARE
  v_signature text;
  v_predecessor text;
  v_original_acl aclitem[];
  v_acl record;
  v_role text;
  v_new_functions text[] := ARRAY[]::text[];
BEGIN
  IF to_regprocedure('admin.is_managed_config_key_before_free_zone(text)') IS NULL THEN
    ALTER FUNCTION admin.is_managed_config_key(text) RENAME TO is_managed_config_key_before_free_zone;
    EXECUTE $ddl$CREATE FUNCTION admin.is_managed_config_key(p_config_key text)
    RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $body$
      SELECT p_config_key = 'free_zone_config'
        OR admin.is_managed_config_key_before_free_zone(p_config_key)
    $body$$ddl$;
    v_new_functions := array_append(v_new_functions, 'admin.is_managed_config_key(text)');
  END IF;
  IF to_regprocedure('admin.validate_managed_config_value_before_free_zone(text,jsonb,text)') IS NULL THEN
    ALTER FUNCTION admin.validate_managed_config_value(text,jsonb,text)
      RENAME TO validate_managed_config_value_before_free_zone;
    EXECUTE $ddl$CREATE FUNCTION admin.validate_managed_config_value(
      p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL
    ) RETURNS void LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $body$
    BEGIN
      -- 字段规则在 shared zod 里；库里只保证存的是 JSON 对象，防止畸形发布落库。
      IF p_config_key = 'free_zone_config' THEN
        IF p_text_value IS NOT NULL OR p_value IS NULL OR jsonb_typeof(p_value) <> 'object' THEN
          RAISE EXCEPTION 'free zone config requires a JSON object' USING ERRCODE = '22023';
        END IF;
        RETURN;
      END IF;
      PERFORM admin.validate_managed_config_value_before_free_zone(p_config_key, p_value, p_text_value);
    END $body$$ddl$;
    v_new_functions := array_append(v_new_functions, 'admin.validate_managed_config_value(text,jsonb,text)');
  END IF;
  -- 新函数沿用被改名的前任函数的 EXECUTE 权限，不自己发明新权限。
  FOREACH v_signature IN ARRAY v_new_functions LOOP
    v_predecessor := CASE v_signature
      WHEN 'admin.is_managed_config_key(text)'
        THEN 'admin.is_managed_config_key_before_free_zone(text)'
      ELSE 'admin.validate_managed_config_value_before_free_zone(text,jsonb,text)'
    END;
    SELECT coalesce(p.proacl, acldefault('f', p.proowner)) INTO v_original_acl
      FROM pg_proc p WHERE p.oid = to_regprocedure(v_predecessor);
    FOR v_acl IN
      SELECT DISTINCT acl.grantee
      FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      WHERE p.oid = to_regprocedure(v_signature)
    LOOP
      v_role := CASE WHEN v_acl.grantee = 0 THEN 'PUBLIC'
        ELSE quote_ident(pg_get_userbyid(v_acl.grantee)) END;
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', v_signature, v_role);
    END LOOP;
    FOR v_acl IN SELECT * FROM aclexplode(v_original_acl) LOOP
      v_role := CASE WHEN v_acl.grantee = 0 THEN 'PUBLIC'
        ELSE quote_ident(pg_get_userbyid(v_acl.grantee)) END;
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s', v_signature, v_role,
        CASE WHEN v_acl.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END LOOP;
END
$extend_functions$;

DO $widen_checks$
DECLARE
  v_table regclass;
  v_name text;
  v_expression text;
  v_validated boolean;
  v_allowed boolean;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'admin.config_drafts'::regclass, 'admin.config_releases'::regclass
  ] LOOP
    v_name := CASE v_table
      WHEN 'admin.config_drafts'::regclass THEN 'config_drafts_config_key_check'
      ELSE 'config_releases_config_key_check'
    END;
    SELECT pg_get_expr(c.conbin, c.conrelid), c.convalidated
      INTO v_expression, v_validated
    FROM pg_constraint c
    WHERE c.conrelid = v_table AND c.conname = v_name AND c.contype = 'c';
    IF v_expression IS NULL THEN
      RAISE EXCEPTION 'free zone: missing constraint %.%', v_table, v_name;
    END IF;
    EXECUTE format('SELECT (%s) FROM (SELECT $1::text AS config_key) AS candidate', v_expression)
      INTO v_allowed USING 'free_zone_config';
    IF v_allowed IS DISTINCT FROM true THEN
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_table, v_name);
      EXECUTE format(
        'ALTER TABLE %s ADD CONSTRAINT %I CHECK ((%s) OR admin.is_managed_config_key(config_key))%s',
        v_table, v_name, v_expression,
        CASE WHEN v_validated THEN '' ELSE ' NOT VALID' END
      );
      SELECT pg_get_expr(c.conbin, c.conrelid) INTO v_expression
      FROM pg_constraint c
      WHERE c.conrelid = v_table AND c.conname = v_name AND c.contype = 'c';
    END IF;
    EXECUTE format('SELECT (%s) FROM (SELECT $1::text AS config_key) AS candidate', v_expression)
      INTO v_allowed USING 'free_zone_config';
    IF v_allowed IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'free zone: key rejected by %', v_table;
    END IF;
    EXECUTE format('SELECT (%s) FROM (SELECT $1::text AS config_key) AS candidate', v_expression)
      INTO v_allowed USING '__unknown_config_key__';
    IF v_allowed IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'free zone: unknown key accepted by %', v_table;
    END IF;
  END LOOP;
END
$widen_checks$;

COMMIT;
NOTIFY pgrst, 'reload schema';
