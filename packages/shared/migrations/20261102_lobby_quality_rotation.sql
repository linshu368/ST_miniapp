-- domain: miniapp_features (personal recommendation state and runtime quality evidence)
-- Cross-schema roots: app_core.users/characters. Admin validation delegates all existing managed keys.
-- MIGRATION only, no remote execution implied. Apply before backend; enable rotation only after
-- the qualified-v1 daily score refresh succeeds. No backfill from the pre-qualification score.
-- Rollback: disable rotation/revert consumers, retain tables and evidence. Do not DROP user state.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';

CREATE TABLE IF NOT EXISTS miniapp_features.user_lobby_recommendations (
  user_id uuid NOT NULL,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_lobby_recommendations_pkey PRIMARY KEY (user_id),
  CONSTRAINT user_lobby_recommendations_user_fkey FOREIGN KEY (user_id)
    REFERENCES app_core.users(id) ON DELETE CASCADE,
  CONSTRAINT user_lobby_recommendations_state_check CHECK ((
    jsonb_typeof(state) = 'object' AND jsonb_typeof(state->'current') = 'object'
    AND jsonb_typeof(state->'recent') = 'array' AND jsonb_array_length(state->'recent') <= 3
    AND pg_column_size(state) <= 1048576
  ) IS TRUE)
);
COMMENT ON TABLE miniapp_features.user_lobby_recommendations IS
  'Backend-owned current/previous full recommendation order and three recent head summaries; never chat content';
COMMENT ON COLUMN miniapp_features.user_lobby_recommendations.state IS
  'Bounded current and previous batches, undo deadline, three request IDs/head lists; per-user transaction lock serializes changes';

CREATE TABLE IF NOT EXISTS miniapp_features.user_character_exposures (
  user_id uuid NOT NULL,
  character_id uuid NOT NULL,
  last_seen_at timestamptz NOT NULL,
  seen_batch_ids uuid[] NOT NULL,
  CONSTRAINT user_character_exposures_pkey PRIMARY KEY (user_id, character_id),
  CONSTRAINT user_character_exposures_user_fkey FOREIGN KEY (user_id)
    REFERENCES app_core.users(id) ON DELETE CASCADE,
  CONSTRAINT user_character_exposures_character_fkey FOREIGN KEY (character_id)
    REFERENCES app_core.characters(id) ON DELETE CASCADE,
  CONSTRAINT user_character_exposures_batch_count_check CHECK (
    cardinality(seen_batch_ids) BETWEEN 1 AND 3 AND array_ndims(seen_batch_ids) = 1
    AND array_position(seen_batch_ids, NULL) IS NULL
  )
);
CREATE INDEX IF NOT EXISTS user_character_exposures_character_idx
  ON miniapp_features.user_character_exposures(character_id);
COMMENT ON TABLE miniapp_features.user_character_exposures IS
  'Last actual card exposure per user; frontend requires >=50% visible for >=1s; server validates owned batch membership';
COMMENT ON COLUMN miniapp_features.user_character_exposures.seen_batch_ids IS
  'Three batch IDs deduplicate retries and undo without a growing event log';

ALTER TABLE miniapp_features.user_lobby_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp_features.user_character_exposures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp_features.user_lobby_recommendations, miniapp_features.user_character_exposures
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  miniapp_features.user_lobby_recommendations, miniapp_features.user_character_exposures TO service_role;
GRANT USAGE ON SCHEMA miniapp_features TO service_role;

ALTER TABLE miniapp_features.character_ranking_scores
  ADD COLUMN IF NOT EXISTS quality_version text,
  ADD COLUMN IF NOT EXISTS trusted_score numeric,
  ADD COLUMN IF NOT EXISTS trusted_sample_size integer,
  ADD COLUMN IF NOT EXISTS trusted_at timestamptz;
COMMENT ON COLUMN miniapp_features.character_ranking_scores.quality_version IS
  'NULL legacy evidence; qualified-v1 means first-touch qualification required >=24h platform experience and >=10 valid turns';
COMMENT ON COLUMN miniapp_features.character_ranking_scores.trusted_score IS
  'Most recent qualified-v1 score with enough independent users. Never backfilled from legacy scores';
COMMENT ON COLUMN miniapp_features.character_ranking_scores.trusted_at IS
  'Timestamp of last sufficiently sampled qualified observation; older than 90 days only eligible for exploration';

DO $guard$
BEGIN
  PERFORM set_config('st_miniapp.install_lobby_rotation', 'false', true);
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'miniapp_features.character_ranking_scores'::regclass
    AND conname = 'character_ranking_scores_trusted_check') THEN
    ALTER TABLE miniapp_features.character_ranking_scores ADD CONSTRAINT character_ranking_scores_trusted_check CHECK (
      (trusted_score IS NULL AND trusted_sample_size IS NULL AND trusted_at IS NULL)
      OR (trusted_score IS NOT NULL AND trusted_score BETWEEN 0 AND 100
        AND trusted_sample_size IS NOT NULL AND trusted_sample_size > 0 AND trusted_at IS NOT NULL)
    );
  END IF;
  IF to_regprocedure('admin.validate_managed_config_value_before_lobby_rotation(text,jsonb,text)') IS NULL THEN
    IF to_regprocedure('admin.validate_managed_config_value(text,jsonb,text)') IS NULL THEN
      RAISE EXCEPTION 'Missing managed configuration validator; stop before application release';
    END IF;
    ALTER FUNCTION admin.validate_managed_config_value(text,jsonb,text)
      RENAME TO validate_managed_config_value_before_lobby_rotation;
    PERFORM set_config('st_miniapp.install_lobby_rotation', 'true', true);
  END IF;
END;
$guard$;

-- Add optional fields without replacing the existing whitelist or any other team's validators.
DO $install_wrapper$
BEGIN
IF current_setting('st_miniapp.install_lobby_rotation') = 'true' THEN
EXECUTE $ddl$
CREATE OR REPLACE FUNCTION admin.validate_managed_config_value(
  p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $fn$
DECLARE
  v_rotation jsonb;
  v_field text;
  v_value numeric;
  v_lower integer;
  v_upper integer;
BEGIN
  PERFORM admin.validate_managed_config_value_before_lobby_rotation(p_config_key, p_value, p_text_value);
  IF p_config_key = 'lobby_ranking_params' AND p_value ? 'rotation' THEN
    v_rotation := p_value->'rotation';
    IF jsonb_typeof(v_rotation) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_rotation->'enabled') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'Invalid lobby rotation configuration' USING ERRCODE = '22023';
    END IF;
    FOR v_field, v_lower, v_upper IN SELECT * FROM (VALUES
      ('interval_hours', 1, 168), ('max_repeat', 0, 12),
      ('exploration_count', 0, 2), ('rollout_percent', 0, 100)
    ) AS bounds(field, lower_bound, upper_bound)
    LOOP
      IF jsonb_typeof(v_rotation->v_field) IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'Invalid lobby rotation field %', v_field USING ERRCODE = '22023';
      END IF;
      v_value := (v_rotation->>v_field)::numeric;
      IF v_value <> trunc(v_value) OR v_value < v_lower OR v_value > v_upper THEN
        RAISE EXCEPTION 'Invalid lobby rotation range %', v_field USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;
  IF p_config_key = 'lobby_pinned_characters' AND p_value ? 'fixed_character_id'
    AND jsonb_typeof(p_value->'fixed_character_id') IS DISTINCT FROM 'null' THEN
    IF jsonb_typeof(p_value->'fixed_character_id') IS DISTINCT FROM 'string'
      OR (p_value->>'fixed_character_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Invalid fixed character ID' USING ERRCODE = '22023';
    END IF;
  END IF;
END;
$fn$;
COMMENT ON FUNCTION admin.validate_managed_config_value(text,jsonb,text) IS
  'Existing managed validation plus optional lobby rotation/fixed card fields; preserves all prior key validation';
$ddl$;
END IF;
END;
$install_wrapper$;

DO $preserve_validator_access$
DECLARE
  v_owner oid;
  v_acl aclitem[];
  v_entry record;
  v_grantee text;
BEGIN
  IF current_setting('st_miniapp.install_lobby_rotation') <> 'true' THEN RETURN; END IF;
  SELECT proowner, coalesce(proacl, acldefault('f', proowner)) INTO v_owner, v_acl
    FROM pg_proc WHERE oid = 'admin.validate_managed_config_value_before_lobby_rotation(text,jsonb,text)'::regprocedure;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'admin.validate_managed_config_value_before_lobby_rotation(text,jsonb,text)'::regprocedure AND prosecdef) THEN
    RAISE EXCEPTION 'Unexpected SECURITY DEFINER managed validator; stop for review';
  END IF;
  EXECUTE format('ALTER FUNCTION admin.validate_managed_config_value(text,jsonb,text) OWNER TO %I', pg_get_userbyid(v_owner));
  -- Remove both PUBLIC's default and any installation-specific default grants, then copy the
  -- predecessor's effective privileges, including custom internal roles and grant options.
  FOR v_entry IN
    SELECT DISTINCT acl.grantee FROM pg_proc p,
      LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    WHERE p.oid = 'admin.validate_managed_config_value(text,jsonb,text)'::regprocedure
  LOOP
    v_grantee := CASE WHEN v_entry.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_entry.grantee)) END;
    EXECUTE 'REVOKE ALL ON FUNCTION admin.validate_managed_config_value(text,jsonb,text) FROM ' || v_grantee;
  END LOOP;
  FOR v_entry IN SELECT * FROM aclexplode(v_acl)
  LOOP
    v_grantee := CASE WHEN v_entry.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_entry.grantee)) END;
    EXECUTE 'GRANT EXECUTE ON FUNCTION admin.validate_managed_config_value(text,jsonb,text) TO ' || v_grantee
      || CASE WHEN v_entry.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
  END LOOP;
END;
$preserve_validator_access$;

-- Present schemas normally use is_managed_config_key in their CHECKs, which we never rename.
-- If an installation also bound a CHECK to the validator OID, only rebind that exact call;
-- retain its complete expression, scope and prior validation state.
DO $rebind_validator_checks$
DECLARE
  v_check record;
  v_expression text;
BEGIN
  IF current_setting('st_miniapp.install_lobby_rotation') <> 'true' THEN RETURN; END IF;
  FOR v_check IN
    SELECT c.oid, c.conrelid, c.conname, c.convalidated, pg_get_expr(c.conbin, c.conrelid) AS expression
    FROM pg_constraint c
    WHERE c.contype = 'c'
      AND c.conrelid IN (to_regclass('admin.config_drafts'), to_regclass('admin.config_releases'))
      AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_constraint'::regclass
        AND d.objid = c.oid AND d.refclassid = 'pg_proc'::regclass
        AND d.refobjid = 'admin.validate_managed_config_value_before_lobby_rotation(text,jsonb,text)'::regprocedure)
  LOOP
    v_expression := replace(v_check.expression,
      'validate_managed_config_value_before_lobby_rotation(', 'validate_managed_config_value(');
    IF v_expression = v_check.expression THEN
      RAISE EXCEPTION 'Unrecognized validator CHECK dependency; stop for review';
    END IF;
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_check.conrelid::regclass, v_check.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%s)%s',
      v_check.conrelid::regclass, v_check.conname, v_expression,
      CASE WHEN v_check.convalidated THEN '' ELSE ' NOT VALID' END);
  END LOOP;
END;
$rebind_validator_checks$;
COMMIT;
