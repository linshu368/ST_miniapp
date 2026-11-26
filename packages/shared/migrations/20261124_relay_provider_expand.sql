-- Domain: ops (O calls/J jobs), experience (delivery), admin/app_core (C managed policy), analytics (D).
-- Expand only. No wallet/usage charge amounts or historical costs are changed. No provider-specific tables.
-- Sources/ownership and recovery: docs/relay-providers.md and task design section 4.
-- Run one file at a time: local PG17 -> TEST -> separately approved production -> deploy consumers -> publish models.
-- Function guards match catalog-only TEST inspection on 2026-11-24; production requires independent verification.
-- Both original files corrected at user explicit request after TEST failure; prior failed checksums are preserved in task research.

DO $preflight$
DECLARE item record; fn regprocedure; source_hash text;
BEGIN
  PERFORM set_config('statement_timeout','60s',true);
  IF to_regclass('analytics.llm_call_costs') IS NULL THEN
    RAISE EXCEPTION 'relay_provider: missing prerequisite cost view; inspect migration ledger';
  END IF;
  -- Verify all function sources before expansion DDL, preserving unrelated published changes.
  FOR item IN SELECT * FROM (VALUES
    ('admin.validate_model_catalog_core(jsonb)','2de1f8d0a75cbd17230b05bb9aaffa0e','ac87e45e0221afc2f38b2e1253d1c9ec'),
    ('experience.record_llm_call_metadata(uuid,text,jsonb)','f0a845f721d4b8d1168bf551b05f424a','f47fdd7731eafbf438d800702a1bc17e'),
    ('experience.select_chat_generation_delivery(uuid,uuid,text)','97423ad8f4ef08540838d2a72f87aa98','d00e7d6d4e4c22132d91fa025cf504b5'),
    ('experience.list_chat_settlement_candidates(text,timestamp with time zone,integer,timestamp with time zone)','44f73038f32828b16f9d5f5559123daf','cece9ccc0f0395a0c2415a1413c69a74'),
    ('admin.validate_managed_config_value(text,jsonb,text)','fc373bfbf14d11b66d985ed20d3a9703','86feaf01470b2043b395d7b1244673e4')
  ) x(signature,old_hash,new_hash) LOOP
    fn := to_regprocedure(item.signature);
    IF fn IS NULL THEN RAISE EXCEPTION 'relay_provider: missing prerequisite function %',item.signature; END IF;
    SELECT md5(replace(prosrc,E'\r','')) INTO source_hash FROM pg_proc WHERE oid=fn;
    IF source_hash NOT IN (item.old_hash,item.new_hash) THEN
      RAISE EXCEPTION 'relay_provider: function source drift in %; reconcile before migration',item.signature;
    END IF;
  END LOOP;
END
$preflight$;

DO $expand$
DECLARE c record; definition text; expected text;
BEGIN
  PERFORM set_config('lock_timeout', '1s', true);
  PERFORM set_config('statement_timeout', '60s', true);
  FOR c IN SELECT * FROM (VALUES
    ('ops','llm_calls','provider','llm_calls_provider_check'),
    ('experience','chat_generation_attempts','provider','chat_generation_attempts_provider_check'),
    ('experience','chat_generation_requests','requested_provider','chat_generation_requests_requested_provider_check')
  ) x(ns,tbl,col,con) LOOP
    SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid=format('%I.%I',c.ns,c.tbl)::regclass AND conname=c.con AND contype='c';
    expected := format('CHECK ((%s = ANY (ARRAY[''openrouter''::text, ''venice''::text, ''surplus''::text])))',c.col);
    IF definition IS DISTINCT FROM expected AND definition IS DISTINCT FROM replace(expected,'''surplus''::text]', '''surplus''::text, ''packy''::text, ''onexmodel''::text]')
       AND definition IS DISTINCT FROM replace(expected,'''surplus''::text]', '''surplus''::text, ''packy''::text, ''onexmodel''::text]') || ' NOT VALID' THEN
      RAISE EXCEPTION 'relay_provider: unexpected provider constraint';
    END IF;
    IF position('packy' IN definition)=0 THEN
      EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I',c.ns,c.tbl,c.con);
      EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (%I IN (''openrouter'',''venice'',''surplus'',''packy'',''onexmodel'')) NOT VALID',c.ns,c.tbl,c.con,c.col);
    END IF;
  END LOOP;
  ALTER TABLE ops.llm_calls
    ADD COLUMN IF NOT EXISTS upstream_log_id text,
    ADD COLUMN IF NOT EXISTS provider_account_ref text,
    ADD COLUMN IF NOT EXISTS cost_native_amount numeric,
    ADD COLUMN IF NOT EXISTS cost_native_unit text,
    ADD COLUMN IF NOT EXISTS cost_usd_per_native_unit numeric;
  ALTER TABLE ops.llm_cost_jobs ADD COLUMN IF NOT EXISTS lease_token uuid, ADD COLUMN IF NOT EXISTS lease_until timestamptz;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='ops.llm_calls'::regclass AND conname='llm_calls_relay_cost_check') THEN
    ALTER TABLE ops.llm_calls ADD CONSTRAINT llm_calls_relay_cost_check CHECK (
      (upstream_log_id IS NULL OR (provider_account_ref IS NOT NULL AND length(upstream_log_id) BETWEEN 1 AND 512))
      AND (provider_account_ref IS NULL OR length(provider_account_ref) BETWEEN 1 AND 128)
      AND (cost_native_amount IS NULL OR (cost_native_amount >= 0 AND cost_native_amount < 'Infinity'::numeric))
      AND (cost_native_unit IS NULL OR cost_native_unit='quota')
      AND ((cost_native_amount IS NULL) = (cost_native_unit IS NULL))
      AND (cost_usd_per_native_unit IS NULL OR (cost_usd_per_native_unit > 0 AND cost_usd_per_native_unit < 'Infinity'::numeric))
      AND (provider NOT IN ('packy','onexmodel') OR raw_usage IS NULL OR octet_length(raw_usage::text)<=32768)
    ) NOT VALID;
  END IF;
END
$expand$;

-- Concurrent index creation is deliberately outside DO/BEGIN for transaction-pool compatibility.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS llm_calls_relay_invoice_unique
  ON ops.llm_calls(provider,provider_account_ref,upstream_log_id) WHERE upstream_log_id IS NOT NULL;

ALTER TABLE ops.llm_calls VALIDATE CONSTRAINT llm_calls_provider_check;
ALTER TABLE experience.chat_generation_attempts VALIDATE CONSTRAINT chat_generation_attempts_provider_check;
ALTER TABLE experience.chat_generation_requests VALIDATE CONSTRAINT chat_generation_requests_requested_provider_check;
ALTER TABLE ops.llm_calls VALIDATE CONSTRAINT llm_calls_relay_cost_check;

COMMENT ON COLUMN ops.llm_calls.upstream_log_id IS 'Exact management invoice identity, never a time/model heuristic; unique per provider/account configuration.';
COMMENT ON COLUMN ops.llm_calls.provider_account_ref IS 'Non-sensitive local provider/environment/credential fingerprint; no plaintext account or Key.';
COMMENT ON COLUMN ops.llm_calls.cost_native_amount IS 'Provider quota debited for this call; unknown remains NULL, valid zero is preserved.';
COMMENT ON COLUMN ops.llm_calls.cost_native_unit IS 'Native provider unit: quota. Not USD or CNY.';
COMMENT ON COLUMN ops.llm_calls.cost_usd_per_native_unit IS 'Frozen USD per quota at invoice attribution, only with published version/source; NULL means unknown USD.';
COMMENT ON COLUMN ops.llm_cost_jobs.lease_token IS 'Worker lease identity; only its current owner may finish/retry a call_cost job.';
COMMENT ON COLUMN ops.llm_cost_jobs.lease_until IS 'Finite worker lease deadline; expired owners cannot commit cost attribution.';

CREATE OR REPLACE FUNCTION admin.validate_llm_relay_provider_config(p_value jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $policy$
DECLARE provider text; policy jsonb; field text;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_value) k WHERE k NOT IN ('packy','onexmodel')) THEN
    RAISE EXCEPTION 'Invalid relay provider policy' USING ERRCODE='22023';
  END IF;
  FOREACH provider IN ARRAY ARRAY['packy','onexmodel'] LOOP
    policy := p_value->provider;
    IF jsonb_typeof(policy) IS DISTINCT FROM 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(policy) k
       WHERE k NOT IN ('quota_per_unit','cny_per_unit','usd_per_cny','conversion_version','conversion_source','monitor_enabled','low_balance_quota')) THEN
      RAISE EXCEPTION 'Invalid relay provider policy fields' USING ERRCODE='22023';
    END IF;
    FOREACH field IN ARRAY ARRAY['quota_per_unit','cny_per_unit','usd_per_cny','low_balance_quota'] LOOP
      IF policy ? field AND policy->field <> 'null'::jsonb THEN
        IF jsonb_typeof(policy->field) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid relay policy number' USING ERRCODE='22023'; END IF;
        IF (policy->>field)::numeric < 0 OR (field <> 'low_balance_quota' AND (policy->>field)::numeric=0) THEN
          RAISE EXCEPTION 'Invalid relay policy range' USING ERRCODE='22023';
        END IF;
      END IF;
    END LOOP;
    FOREACH field IN ARRAY ARRAY['conversion_version','conversion_source'] LOOP
      IF policy ? field AND policy->field <> 'null'::jsonb AND (jsonb_typeof(policy->field) IS DISTINCT FROM 'string'
         OR length(btrim(policy->>field)) NOT BETWEEN 1 AND CASE field WHEN 'conversion_version' THEN 64 ELSE 256 END) THEN
        RAISE EXCEPTION 'Invalid relay conversion provenance' USING ERRCODE='22023';
      END IF;
    END LOOP;
    IF policy ? 'monitor_enabled' AND jsonb_typeof(policy->'monitor_enabled') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'Invalid relay monitor flag' USING ERRCODE='22023';
    END IF;
    IF policy->'monitor_enabled'='true'::jsonb AND COALESCE(policy->'low_balance_quota','null'::jsonb)='null'::jsonb THEN
      RAISE EXCEPTION 'Relay monitoring requires a native threshold' USING ERRCODE='22023';
    END IF;
    IF COALESCE(policy->'usd_per_cny','null'::jsonb)<>'null'::jsonb AND (
       COALESCE(policy->'quota_per_unit','null'::jsonb)='null'::jsonb OR COALESCE(policy->'cny_per_unit','null'::jsonb)='null'::jsonb
       OR COALESCE(policy->'conversion_version','null'::jsonb)='null'::jsonb OR COALESCE(policy->'conversion_source','null'::jsonb)='null'::jsonb) THEN
      RAISE EXCEPTION 'Relay USD conversion requires units and provenance' USING ERRCODE='22023';
    END IF;
  END LOOP;
END
$policy$;
REVOKE ALL ON FUNCTION admin.validate_llm_relay_provider_config(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION admin.validate_llm_relay_provider_config(jsonb) TO service_role;

-- Guarded, in-place function edits are appended from the source-derived baselines below.

DO $functions$
DECLARE item record; fn regprocedure; source text; definition text;
BEGIN
  PERFORM set_config('statement_timeout','60s',true);
  FOR item IN SELECT * FROM (VALUES
    ('admin.validate_model_catalog_core(jsonb)', '2de1f8d0a75cbd17230b05bb9aaffa0e', 'ac87e45e0221afc2f38b2e1253d1c9ec', $old$NOT IN ('openrouter', 'venice', 'surplus')$old$, $new$NOT IN ('openrouter', 'venice', 'surplus', 'packy', 'onexmodel')$new$),
    ('experience.record_llm_call_metadata(uuid,text,jsonb)', 'f0a845f721d4b8d1168bf551b05f424a', 'f47fdd7731eafbf438d800702a1bc17e', $old$NOT IN ('openrouter', 'venice')$old$, $new$NOT IN ('openrouter', 'venice', 'packy', 'onexmodel')$new$),
    ('experience.select_chat_generation_delivery(uuid,uuid,text)', '97423ad8f4ef08540838d2a72f87aa98', 'd00e7d6d4e4c22132d91fa025cf504b5', $old$NOT IN ('openrouter','venice')$old$, $new$NOT IN ('openrouter','venice','packy','onexmodel')$new$),
    ('experience.list_chat_settlement_candidates(text,timestamp with time zone,integer,timestamp with time zone)', '44f73038f32828b16f9d5f5559123daf', 'cece9ccc0f0395a0c2415a1413c69a74', $old$WHEN p_scan IN ('openrouter', 'venice') THEN$old$, $new$WHEN p_scan IN ('packy', 'onexmodel') THEN
        h.status <> 'streaming' AND uc.quote -> 'snapshot' ->> 'provider' = p_scan
      WHEN p_scan IN ('openrouter', 'venice') THEN$new$),
    ('admin.validate_managed_config_value(text,jsonb,text)', 'fc373bfbf14d11b66d985ed20d3a9703', '86feaf01470b2043b395d7b1244673e4', $old$WHEN 'llm_model_catalog' THEN$old$, $new$WHEN 'llm_relay_provider_config' THEN
      IF p_text_value IS NOT NULL THEN RAISE EXCEPTION 'Relay policy must not use text_value' USING ERRCODE='22023'; END IF;
      PERFORM admin.validate_llm_relay_provider_config(p_value);
    WHEN 'llm_model_catalog' THEN$new$)
  ) x(signature,old_hash,new_hash,anchor,replacement) LOOP
    fn := to_regprocedure(item.signature);
    IF fn IS NULL THEN RAISE EXCEPTION 'relay_provider: missing prerequisite function'; END IF;
    SELECT replace(prosrc,E'\r','') INTO source FROM pg_proc WHERE oid=fn;
    IF md5(source)=item.new_hash THEN CONTINUE; END IF;
    IF md5(source)<>item.old_hash OR cardinality(string_to_array(source,item.anchor))<>2 THEN
      RAISE EXCEPTION 'relay_provider: function source drift, reconcile this environment before migration';
    END IF;
    definition := replace(pg_get_functiondef(fn),E'\r','');
    EXECUTE replace(definition,item.anchor,item.replacement);
    IF (SELECT md5(replace(prosrc,E'\r','')) FROM pg_proc WHERE oid=fn)<>item.new_hash THEN
      RAISE EXCEPTION 'relay_provider: function patch checksum mismatch';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM admin.managed_config_keys WHERE config_key='llm_relay_provider_config'
             AND (retired_at IS NOT NULL OR managed_via<>'operations_config')) THEN
    RAISE EXCEPTION 'relay_provider: managed policy registration conflict';
  END IF;
  INSERT INTO admin.managed_config_keys(config_key,managed_via,note)
    VALUES('llm_relay_provider_config','operations_config','Relay native units, versioned conversion and opt-in balance monitoring; no credentials')
    ON CONFLICT(config_key) DO NOTHING;
END
$functions$;

-- Idempotent cost projection repair also protects partial rollout recovery.
DO $cost_view$
DECLARE target regclass; definition text; changed text; matches integer; options text;
BEGIN
  PERFORM set_config('lock_timeout','1s',true);
  PERFORM set_config('statement_timeout','60s',true);
  target := to_regclass('analytics.llm_call_costs');
  IF target IS NULL THEN
    RAISE EXCEPTION 'relay_provider: missing prerequisite cost view in analytics; inspect migration ledger';
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid=target)<>'v' THEN
    RAISE EXCEPTION 'relay_provider: cost projection is not an ordinary view';
  END IF;
  definition := pg_get_viewdef(target,true);
  changed := definition;
  IF NOT (position('packy' IN definition)>0 AND position('onexmodel' IN definition)>0) THEN
    SELECT count(*) INTO matches FROM regexp_matches(definition,'COALESCE\(l\.cost_usd, \(?0\)?::numeric\)','g');
    IF matches<>1 THEN RAISE EXCEPTION 'relay_provider: reconcile unknown cost view definition before migration'; END IF;
    changed := regexp_replace(definition,'COALESCE\(l\.cost_usd, \(?0\)?::numeric\)',
      '(CASE WHEN l.provider IN (''packy'', ''onexmodel'') THEN l.cost_usd ELSE COALESCE(l.cost_usd, 0::numeric) END)');
  END IF;
  -- PG17 emits both parenthesized and bare booleans. Native invoices with unknown USD remain pending.
  IF position('l.cost_usd IS NULL' IN regexp_replace(changed,'[()]','','g'))=0 THEN
    SELECT count(*) INTO matches FROM regexp_matches(changed,'\(?l\.cost_source IS NULL\)? AS cost_pending','g');
    IF matches<>1 THEN RAISE EXCEPTION 'relay_provider: reconcile unknown cost_pending definition'; END IF;
    changed := regexp_replace(changed,'\(?l\.cost_source IS NULL\)? AS cost_pending',
      '(l.cost_source IS NULL OR (l.provider IN (''packy'', ''onexmodel'') AND l.cost_usd IS NULL)) AS cost_pending');
  END IF;
  IF changed<>definition THEN
    SELECT string_agg(format('%I=%L',option_name,option_value),', ') INTO options
      FROM pg_options_to_table((SELECT reloptions FROM pg_class WHERE oid=target));
    EXECUTE format('CREATE OR REPLACE VIEW %s%s AS %s',target,
      CASE WHEN options IS NULL THEN '' ELSE format(' WITH (%s)',options) END,changed);
  END IF;
END
$cost_view$;

DO $postflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='ops.llm_calls_relay_invoice_unique'::regclass AND indisvalid AND indisunique) THEN
    RAISE EXCEPTION 'relay_provider: invoice uniqueness index is invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='ops.llm_calls'::regclass AND relrowsecurity)
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='ops.llm_cost_jobs'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'relay_provider: existing observation RLS missing';
  END IF;
  PERFORM admin.validate_llm_relay_provider_config('{"packy":{},"onexmodel":{}}'::jsonb);
END
$postflight$;
NOTIFY pgrst, 'reload schema';
