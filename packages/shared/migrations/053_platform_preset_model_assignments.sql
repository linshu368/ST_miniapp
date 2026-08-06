-- Platform preset assignment by stable model id.
--
-- The current-state table is optimized for runtime resolution. The event table
-- is append-only audit history. Assignment changes advance an independent,
-- monotonic version so active clients can reconcile within the polling window.

BEGIN;

CREATE TABLE st_platform.platform_preset_model_assignments (
  model_id   TEXT PRIMARY KEY,
  preset_id  UUID NOT NULL
    REFERENCES st_platform.platform_presets(id) ON DELETE RESTRICT,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT platform_preset_model_assignments_model_id_check
    CHECK (model_id = trim(model_id) AND char_length(model_id) BETWEEN 1 AND 64)
);

CREATE INDEX idx_platform_preset_model_assignments_preset
  ON st_platform.platform_preset_model_assignments(preset_id);

CREATE TABLE st_platform.platform_preset_model_assignment_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id         TEXT NOT NULL,
  before_preset_id UUID,
  after_preset_id  UUID,
  action           TEXT NOT NULL
    CHECK (action IN ('assign', 'reassign', 'clear')),
  actor_user_id    UUID,
  actor_email      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_platform_preset_model_assignment_events_model_created
  ON st_platform.platform_preset_model_assignment_events(model_id, created_at DESC);

CREATE TABLE st_platform.platform_preset_model_assignment_state (
  singleton  BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  version    BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO st_platform.platform_preset_model_assignment_state(singleton, version)
VALUES (true, 0);

CREATE OR REPLACE FUNCTION admin.list_platform_preset_model_assignments()
RETURNS TABLE (
  model_id TEXT,
  display_name TEXT,
  sort_order INTEGER,
  preset_id UUID,
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
  )
  SELECT
    models.model_id,
    models.display_name,
    models.sort_order,
    assignment.preset_id,
    state.version
  FROM models
  CROSS JOIN st_platform.platform_preset_model_assignment_state AS state
  LEFT JOIN st_platform.platform_preset_model_assignments AS assignment
    ON assignment.model_id = models.model_id
  ORDER BY models.sort_order, models.display_name, models.model_id;
END;
$$;

CREATE OR REPLACE FUNCTION admin.update_platform_preset_model_assignments(
  p_preset_id UUID,
  p_model_ids TEXT[],
  p_expected_version BIGINT
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_preset st_platform.platform_presets%ROWTYPE;
  v_model_ids TEXT[];
  v_model_id TEXT;
  v_before_preset_id UUID;
  v_before_model_ids TEXT[];
  v_changed BOOLEAN := false;
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

  SELECT ARRAY(
    SELECT DISTINCT trim(candidate)
    FROM unnest(COALESCE(p_model_ids, ARRAY[]::TEXT[])) AS candidate
    WHERE char_length(trim(candidate)) > 0
    ORDER BY trim(candidate)
  ) INTO v_model_ids;

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

  SELECT preset.* INTO v_preset
  FROM st_platform.platform_presets AS preset
  WHERE preset.id = p_preset_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform preset not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_preset.enabled AND cardinality(v_model_ids) > 0 THEN
    RAISE EXCEPTION '已停用的预设不能分配给模型'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(v_model_ids) AS requested(model_id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM miniapp.runtime_config AS runtime
      CROSS JOIN LATERAL jsonb_array_elements(runtime.value -> 'tiers') AS tier
      CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
      WHERE runtime.key = 'llm_model_catalog'
        AND trim(model ->> 'id') = requested.model_id
        AND model -> 'enabled' = 'true'::JSONB
    )
  ) THEN
    RAISE EXCEPTION '所选模型不存在或已停用，请刷新模型目录后重试'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(assignment.model_id ORDER BY assignment.model_id), ARRAY[]::TEXT[])
  INTO v_before_model_ids
  FROM st_platform.platform_preset_model_assignments AS assignment
  WHERE assignment.preset_id = p_preset_id;

  INSERT INTO st_platform.platform_preset_model_assignment_events (
    model_id, before_preset_id, after_preset_id, action,
    actor_user_id, actor_email
  )
  SELECT
    assignment.model_id,
    assignment.preset_id,
    NULL,
    'clear',
    v_actor.user_id,
    v_actor.email
  FROM st_platform.platform_preset_model_assignments AS assignment
  WHERE assignment.preset_id = p_preset_id
    AND NOT (assignment.model_id = ANY(v_model_ids));

  DELETE FROM st_platform.platform_preset_model_assignments AS assignment
  WHERE assignment.preset_id = p_preset_id
    AND NOT (assignment.model_id = ANY(v_model_ids));

  IF FOUND THEN
    v_changed := true;
  END IF;

  FOREACH v_model_id IN ARRAY v_model_ids LOOP
    SELECT assignment.preset_id INTO v_before_preset_id
    FROM st_platform.platform_preset_model_assignments AS assignment
    WHERE assignment.model_id = v_model_id
    FOR UPDATE;

    IF v_before_preset_id IS NOT DISTINCT FROM p_preset_id THEN
      CONTINUE;
    END IF;

    INSERT INTO st_platform.platform_preset_model_assignment_events (
      model_id, before_preset_id, after_preset_id, action,
      actor_user_id, actor_email
    ) VALUES (
      v_model_id,
      v_before_preset_id,
      p_preset_id,
      CASE WHEN v_before_preset_id IS NULL THEN 'assign' ELSE 'reassign' END,
      v_actor.user_id,
      v_actor.email
    );

    INSERT INTO st_platform.platform_preset_model_assignments (
      model_id, preset_id, updated_by, updated_at
    ) VALUES (
      v_model_id, p_preset_id, v_actor.user_id, now()
    )
    ON CONFLICT (model_id) DO UPDATE
    SET preset_id = EXCLUDED.preset_id,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at;

    v_changed := true;
  END LOOP;

  IF v_changed THEN
    UPDATE st_platform.platform_preset_model_assignment_state
    SET version = version + 1,
        updated_by = v_actor.user_id,
        updated_at = now()
    WHERE singleton
    RETURNING version INTO v_version;

    INSERT INTO admin.audit_logs (
      actor_user_id, actor_email, environment, action, schema_name,
      table_name, record_id, before_value, after_value
    ) VALUES (
      v_actor.user_id,
      v_actor.email,
      admin.current_environment(),
      'platform_preset.model_assignments_update',
      'st_platform',
      'platform_preset_model_assignments',
      p_preset_id::TEXT,
      jsonb_build_object('model_ids', v_before_model_ids),
      jsonb_build_object('model_ids', v_model_ids, 'assignment_version', v_version)
    );
  ELSE
    v_version := v_current_version;
  END IF;

  RETURN v_version;
END;
$$;

CREATE OR REPLACE FUNCTION st_platform.resolve_effective_preset_for_model(
  p_model_id TEXT,
  p_include_payload BOOLEAN DEFAULT false
)
RETURNS TABLE (
  assignment_version BIGINT,
  effective_preset_id UUID,
  effective_preset_pointer TEXT,
  preset_payload JSONB,
  preset_source TEXT,
  config_code TEXT,
  degraded BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  WITH assigned AS (
    SELECT preset.id, preset.preset_payload, preset.enabled
    FROM st_platform.platform_preset_model_assignments AS assignment
    LEFT JOIN st_platform.platform_presets AS preset
      ON preset.id = assignment.preset_id
    WHERE assignment.model_id = trim(p_model_id)
  ),
  default_preset AS (
    SELECT preset.id, preset.preset_payload
    FROM st_platform.platform_presets AS preset
    WHERE preset.is_default
      AND preset.enabled
    LIMIT 1
  ),
  effective AS (
    SELECT assigned.id, assigned.preset_payload, 'model'::TEXT AS source
    FROM assigned
    WHERE assigned.enabled
    UNION ALL
    SELECT default_preset.id, default_preset.preset_payload, 'default'::TEXT
    FROM default_preset
    WHERE NOT EXISTS (SELECT 1 FROM assigned WHERE assigned.enabled)
    LIMIT 1
  )
  SELECT
    state.version,
    effective.id,
    CASE WHEN effective.id IS NULL THEN NULL ELSE 'platform_' || effective.id::TEXT END,
    CASE WHEN p_include_payload THEN effective.preset_payload ELSE NULL END,
    effective.source,
    CASE
      WHEN effective.id IS NULL THEN 'NO_ENABLED_DEFAULT'
      WHEN EXISTS (SELECT 1 FROM assigned) AND effective.source = 'default'
        THEN 'ASSIGNMENT_INVALID_FALLBACK'
      ELSE 'OK'
    END,
    CASE
      WHEN effective.id IS NULL THEN true
      WHEN EXISTS (SELECT 1 FROM assigned) AND effective.source = 'default' THEN true
      ELSE false
    END
  FROM st_platform.platform_preset_model_assignment_state AS state
  LEFT JOIN effective ON true
  WHERE state.singleton;
$$;

REVOKE ALL ON TABLE st_platform.platform_preset_model_assignments
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE st_platform.platform_preset_model_assignment_events
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE st_platform.platform_preset_model_assignment_state
  FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE st_platform.platform_preset_model_assignments
  TO service_role, postgres;
GRANT SELECT ON TABLE st_platform.platform_preset_model_assignment_state
  TO service_role, postgres;

REVOKE ALL ON FUNCTION admin.list_platform_preset_model_assignments()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.update_platform_preset_model_assignments(UUID, TEXT[], BIGINT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION st_platform.resolve_effective_preset_for_model(TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION admin.list_platform_preset_model_assignments()
  TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.update_platform_preset_model_assignments(UUID, TEXT[], BIGINT)
  TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION st_platform.resolve_effective_preset_for_model(TEXT, BOOLEAN)
  TO service_role, postgres;

COMMENT ON TABLE st_platform.platform_preset_model_assignments IS
  'Current unique platform-preset assignment for each stable model id.';
COMMENT ON TABLE st_platform.platform_preset_model_assignment_events IS
  'Append-only audit history for model preset assignment changes.';
COMMENT ON TABLE st_platform.platform_preset_model_assignment_state IS
  'Singleton monotonic version advanced atomically with assignment changes.';
COMMENT ON FUNCTION admin.update_platform_preset_model_assignments(UUID, TEXT[], BIGINT) IS
  'Atomically replaces one preset model set, moves conflicting assignments, audits changes, and advances the assignment version.';
COMMENT ON FUNCTION st_platform.resolve_effective_preset_for_model(TEXT, BOOLEAN) IS
  'Resolves an enabled model-specific preset, falling back to the enabled global default without blocking generation.';

COMMIT;
