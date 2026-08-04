-- Model-centric platform preset assignment management for the Admin console.

BEGIN;

DROP FUNCTION IF EXISTS admin.list_platform_preset_model_assignments();

CREATE FUNCTION admin.list_platform_preset_model_assignments()
RETURNS TABLE (
  model_id TEXT,
  display_name TEXT,
  sort_order INTEGER,
  preset_id UUID,
  assigned_preset_display_name TEXT,
  effective_preset_id UUID,
  effective_preset_display_name TEXT,
  preset_source TEXT,
  preset_config_code TEXT,
  assignment_updated_at TIMESTAMPTZ,
  assignment_version BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'admin is not permitted to access current environment'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH catalog AS (
    SELECT runtime.value
    FROM miniapp.runtime_config AS runtime
    WHERE runtime.key = 'llm_model_catalog'
  ),
  models AS (
    SELECT
      trim(model ->> 'id') AS model_id,
      model ->> 'display_name' AS display_name,
      COALESCE((model ->> 'sort_order')::INTEGER, 0) AS sort_order
    FROM catalog
    CROSS JOIN LATERAL jsonb_array_elements(catalog.value -> 'tiers') AS tier
    CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
    WHERE model -> 'enabled' = 'true'::JSONB
  ),
  default_preset AS (
    SELECT preset.id, preset.display_name
    FROM st_platform.platform_presets AS preset
    WHERE preset.is_default
      AND preset.enabled
    LIMIT 1
  )
  SELECT
    models.model_id,
    models.display_name,
    models.sort_order,
    assignment.preset_id,
    assigned_preset.display_name,
    CASE
      WHEN assigned_preset.enabled THEN assigned_preset.id
      ELSE default_preset.id
    END,
    CASE
      WHEN assigned_preset.enabled THEN assigned_preset.display_name
      ELSE default_preset.display_name
    END,
    CASE
      WHEN assigned_preset.enabled THEN 'model'::TEXT
      WHEN default_preset.id IS NOT NULL THEN 'default'::TEXT
      ELSE NULL
    END,
    CASE
      WHEN assigned_preset.enabled THEN 'OK'::TEXT
      WHEN assignment.preset_id IS NOT NULL AND default_preset.id IS NOT NULL
        THEN 'ASSIGNMENT_INVALID_FALLBACK'::TEXT
      WHEN default_preset.id IS NULL THEN 'NO_ENABLED_DEFAULT'::TEXT
      ELSE 'OK'::TEXT
    END,
    COALESCE(assignment.updated_at, latest_event.created_at),
    state.version
  FROM models
  CROSS JOIN st_platform.platform_preset_model_assignment_state AS state
  LEFT JOIN st_platform.platform_preset_model_assignments AS assignment
    ON assignment.model_id = models.model_id
  LEFT JOIN st_platform.platform_presets AS assigned_preset
    ON assigned_preset.id = assignment.preset_id
  LEFT JOIN LATERAL (
    SELECT event.created_at
    FROM st_platform.platform_preset_model_assignment_events AS event
    WHERE event.model_id = models.model_id
    ORDER BY event.created_at DESC
    LIMIT 1
  ) AS latest_event ON true
  LEFT JOIN default_preset ON true
  ORDER BY models.sort_order, models.display_name, models.model_id;
END;
$$;

CREATE OR REPLACE FUNCTION admin.update_platform_preset_model_assignment(
  p_model_id TEXT,
  p_preset_id UUID,
  p_expected_version BIGINT
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_model_id TEXT := trim(COALESCE(p_model_id, ''));
  v_preset st_platform.platform_presets%ROWTYPE;
  v_before_preset_id UUID;
  v_current_version BIGINT;
  v_version BIGINT;
BEGIN
  SELECT admin_user.* INTO v_actor
  FROM admin.admin_users AS admin_user
  WHERE admin_user.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('st_platform.platform_preset_model_assignments', 0)
  );

  SELECT state.version INTO v_current_version
  FROM st_platform.platform_preset_model_assignment_state AS state
  WHERE state.singleton
  FOR UPDATE;

  IF p_expected_version IS NULL OR p_expected_version <> v_current_version THEN
    RAISE EXCEPTION '模型预设分配已被其他运营更新，请刷新后重试'
      USING ERRCODE = '40001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM miniapp.runtime_config AS runtime
    CROSS JOIN LATERAL jsonb_array_elements(runtime.value -> 'tiers') AS tier
    CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
    WHERE runtime.key = 'llm_model_catalog'
      AND trim(model ->> 'id') = v_model_id
      AND model -> 'enabled' = 'true'::JSONB
  ) THEN
    RAISE EXCEPTION '所选模型不存在或已停用，请刷新模型目录后重试'
      USING ERRCODE = '22023';
  END IF;

  IF p_preset_id IS NOT NULL THEN
    SELECT preset.* INTO v_preset
    FROM st_platform.platform_presets AS preset
    WHERE preset.id = p_preset_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'platform preset not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT v_preset.enabled THEN
      RAISE EXCEPTION '已停用的预设不能分配给模型'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT assignment.preset_id INTO v_before_preset_id
  FROM st_platform.platform_preset_model_assignments AS assignment
  WHERE assignment.model_id = v_model_id
  FOR UPDATE;

  IF v_before_preset_id IS NOT DISTINCT FROM p_preset_id THEN
    RETURN v_current_version;
  END IF;

  INSERT INTO st_platform.platform_preset_model_assignment_events (
    model_id,
    before_preset_id,
    after_preset_id,
    action,
    actor_user_id,
    actor_email
  ) VALUES (
    v_model_id,
    v_before_preset_id,
    p_preset_id,
    CASE
      WHEN p_preset_id IS NULL THEN 'clear'
      WHEN v_before_preset_id IS NULL THEN 'assign'
      ELSE 'reassign'
    END,
    v_actor.user_id,
    v_actor.email
  );

  IF p_preset_id IS NULL THEN
    DELETE FROM st_platform.platform_preset_model_assignments AS assignment
    WHERE assignment.model_id = v_model_id;
  ELSE
    INSERT INTO st_platform.platform_preset_model_assignments (
      model_id,
      preset_id,
      updated_by,
      updated_at
    ) VALUES (
      v_model_id,
      p_preset_id,
      v_actor.user_id,
      now()
    )
    ON CONFLICT (model_id) DO UPDATE
    SET preset_id = EXCLUDED.preset_id,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at;
  END IF;

  UPDATE st_platform.platform_preset_model_assignment_state
  SET version = version + 1,
      updated_by = v_actor.user_id,
      updated_at = now()
  WHERE singleton
  RETURNING version INTO v_version;

  INSERT INTO admin.audit_logs (
    actor_user_id,
    actor_email,
    environment,
    action,
    schema_name,
    table_name,
    record_id,
    before_value,
    after_value
  ) VALUES (
    v_actor.user_id,
    v_actor.email,
    admin.current_environment(),
    'platform_preset.model_assignment_update',
    'st_platform',
    'platform_preset_model_assignments',
    v_model_id,
    jsonb_build_object('preset_id', v_before_preset_id),
    jsonb_build_object('preset_id', p_preset_id, 'assignment_version', v_version)
  );

  RETURN v_version;
END;
$$;

REVOKE ALL ON FUNCTION admin.list_platform_preset_model_assignments()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.update_platform_preset_model_assignment(TEXT, UUID, BIGINT)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION admin.list_platform_preset_model_assignments()
  TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.update_platform_preset_model_assignment(TEXT, UUID, BIGINT)
  TO authenticated, service_role, postgres;

COMMENT ON FUNCTION admin.list_platform_preset_model_assignments() IS
  'Lists enabled catalog models with direct and effective platform preset assignments.';
COMMENT ON FUNCTION admin.update_platform_preset_model_assignment(TEXT, UUID, BIGINT) IS
  'Atomically assigns or clears one model preset, audits the change, and advances assignment version.';

COMMIT;
