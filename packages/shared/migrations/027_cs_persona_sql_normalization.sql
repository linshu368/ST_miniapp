-- Normalize CS persona membership SQL before validation/execution.
-- Persona refresh only needs a user_id set; top-level ORDER BY is irrelevant and can
-- break SELECT DISTINCT user_id queries when ordering by a non-selected metric.

CREATE OR REPLACE FUNCTION cs_platform.normalize_persona_sql(p_sql TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_sql TEXT := trim(p_sql);
BEGIN
  IF v_sql = '' THEN
    RETURN v_sql;
  END IF;

  IF v_sql !~* '[[:space:]]+(limit|offset|fetch)[[:space:]]+'
     AND v_sql ~* '[[:space:]]+order[[:space:]]+by[[:space:]]+' THEN
    v_sql := regexp_replace(v_sql, '[[:space:]]+order[[:space:]]+by[[:space:]].*$', '', 'i');
  END IF;

  RETURN trim(v_sql);
END;
$$;

CREATE OR REPLACE FUNCTION cs_platform.validate_persona_sql(p_sql TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_sql TEXT := cs_platform.normalize_persona_sql(p_sql);
  v_plan JSONB;
  v_has_modify_node BOOLEAN := false;
BEGIN
  IF v_sql = '' THEN
    RAISE EXCEPTION 'persona sql must not be empty'
      USING ERRCODE = '22023';
  END IF;

  IF v_sql LIKE '%;%' THEN
    RAISE EXCEPTION 'persona sql must contain exactly one statement'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    EXECUTE format('EXPLAIN (FORMAT JSON) %s', v_sql) INTO v_plan;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'persona sql validation failed: %', SQLERRM
      USING ERRCODE = '22023';
  END;

  SELECT EXISTS (
    SELECT 1
    FROM jsonb_path_query(v_plan, '$.**') AS node(value)
    WHERE value @> '{"Node Type":"ModifyTable"}'::jsonb
       OR value->>'Operation' IN ('Insert', 'Update', 'Delete', 'Merge')
  )
  INTO v_has_modify_node;

  IF v_has_modify_node THEN
    RAISE EXCEPTION 'persona sql must be read-only SELECT'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION cs_platform.refresh_persona_members(
  p_persona_id UUID,
  p_operator_id TEXT DEFAULT 'system'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_persona cs_platform.personas;
  v_member_sql TEXT;
  v_run_id UUID;
  v_refreshed_at TIMESTAMPTZ := now();
  v_active_count INTEGER := 0;
  v_entered_count INTEGER := 0;
  v_chatted_left_count INTEGER := 0;
BEGIN
  SELECT *
  INTO v_persona
  FROM cs_platform.personas
  WHERE id = p_persona_id
    AND status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'persona not found or archived: %', p_persona_id
      USING ERRCODE = 'P0002';
  END IF;

  v_member_sql := cs_platform.normalize_persona_sql(v_persona.sql_text);
  PERFORM cs_platform.validate_persona_sql(v_member_sql);

  INSERT INTO cs_platform.persona_refresh_runs (persona_id, operator_id, sql_text)
  VALUES (p_persona_id, COALESCE(NULLIF(p_operator_id, ''), 'system'), v_member_sql)
  RETURNING id INTO v_run_id;

  EXECUTE format(
    'INSERT INTO cs_platform.persona_member_snapshots (run_id, persona_id, user_id)
     SELECT %L::uuid, %L::uuid, q.user_id::uuid
     FROM (%s) AS q
     WHERE q.user_id IS NOT NULL
     ON CONFLICT (run_id, user_id) DO NOTHING',
    v_run_id,
    p_persona_id,
    v_member_sql
  );

  INSERT INTO cs_platform.persona_member_state (
    persona_id,
    user_id,
    membership_status,
    first_seen_at,
    last_seen_at,
    last_seen_run_id
  )
  SELECT
    p_persona_id,
    user_id,
    'active',
    v_refreshed_at,
    v_refreshed_at,
    v_run_id
  FROM cs_platform.persona_member_snapshots
  WHERE run_id = v_run_id
  ON CONFLICT (persona_id, user_id) DO UPDATE
  SET
    membership_status = 'active',
    last_seen_at = EXCLUDED.last_seen_at,
    last_seen_run_id = EXCLUDED.last_seen_run_id,
    left_at = NULL,
    left_note = NULL;

  GET DIAGNOSTICS v_entered_count = ROW_COUNT;

  UPDATE cs_platform.persona_member_state state
  SET
    membership_status = 'chatted_left',
    left_at = COALESCE(state.left_at, v_refreshed_at),
    left_note = '用户已不再命中当前画像簇 SQL，但保留本簇回访记录。'
  WHERE state.persona_id = p_persona_id
    AND state.first_contacted_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM cs_platform.persona_member_snapshots snap
      WHERE snap.run_id = v_run_id
        AND snap.user_id = state.user_id
    );

  SELECT count(*)::INTEGER
  INTO v_active_count
  FROM cs_platform.persona_member_state
  WHERE persona_id = p_persona_id
    AND membership_status = 'active';

  SELECT count(*)::INTEGER
  INTO v_chatted_left_count
  FROM cs_platform.persona_member_state
  WHERE persona_id = p_persona_id
    AND membership_status = 'chatted_left';

  UPDATE cs_platform.persona_refresh_runs
  SET
    status = 'succeeded',
    active_count = v_active_count,
    entered_count = v_entered_count,
    chatted_left_count = v_chatted_left_count,
    completed_at = v_refreshed_at
  WHERE id = v_run_id;

  UPDATE cs_platform.personas
  SET
    active_count = v_active_count,
    chatted_left_count = v_chatted_left_count,
    last_refreshed_at = v_refreshed_at,
    updated_at = v_refreshed_at
  WHERE id = p_persona_id;

  INSERT INTO cs_platform.audit_logs (operator_id, action, persona_id, metadata)
  VALUES (
    COALESCE(NULLIF(p_operator_id, ''), 'system'),
    'persona.refresh',
    p_persona_id,
    jsonb_build_object(
      'run_id', v_run_id,
      'active_count', v_active_count,
      'entered_count', v_entered_count,
      'chatted_left_count', v_chatted_left_count
    )
  );

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'active_count', v_active_count,
    'entered_count', v_entered_count,
    'chatted_left_count', v_chatted_left_count,
    'refreshed_at', v_refreshed_at
  );
EXCEPTION WHEN OTHERS THEN
  IF v_run_id IS NOT NULL THEN
    UPDATE cs_platform.persona_refresh_runs
    SET status = 'failed', error_message = SQLERRM, completed_at = now()
    WHERE id = v_run_id;
  END IF;
  RAISE;
END;
$$;
