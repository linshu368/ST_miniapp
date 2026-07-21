-- Admin management APIs for the platform-wide SillyTavern preset pool.
--
-- Preset payloads are immutable snapshots. Editing or restoring a default
-- preset creates a new UUID so provisioned files are never stale.

BEGIN;

-- 025 originally resolved pgcrypto.digest through the caller search_path.
-- Admin RPCs intentionally use a restricted search_path, so make the trigger
-- function resolve the Supabase extensions schema explicitly and consistently.
ALTER FUNCTION st_platform.promote_default_preset()
  SET search_path = pg_catalog, extensions;

CREATE OR REPLACE FUNCTION admin.validate_platform_preset_payload(p_payload JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'platform preset payload must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  IF p_payload = '{}'::JSONB THEN
    RAISE EXCEPTION 'platform preset payload must not be empty'
      USING ERRCODE = '22023';
  END IF;

  IF pg_column_size(p_payload) > 1048576 THEN
    RAISE EXCEPTION 'platform preset payload must not exceed 1 MB'
      USING ERRCODE = '22023';
  END IF;

  IF p_payload ? 'prompts'
     AND jsonb_typeof(p_payload -> 'prompts') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'platform preset prompts must be an array'
      USING ERRCODE = '22023';
  END IF;

  IF p_payload ? 'prompt_order'
     AND jsonb_typeof(p_payload -> 'prompt_order') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'platform preset prompt_order must be an array'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_payload -> 'prompts', '[]'::JSONB)) AS prompt
    WHERE jsonb_typeof(prompt) IS DISTINCT FROM 'object'
      OR COALESCE(char_length(trim(prompt ->> 'identifier')), 0) = 0
  ) THEN
    RAISE EXCEPTION 'every platform preset prompt must have an identifier'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION admin.list_platform_presets()
RETURNS TABLE (
  id UUID,
  display_name TEXT,
  preset_payload JSONB,
  is_default BOOLEAN,
  sort_order INTEGER,
  enabled BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
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
  SELECT
    preset.id,
    preset.display_name,
    preset.preset_payload,
    preset.is_default,
    preset.sort_order,
    preset.enabled,
    preset.created_at,
    preset.updated_at
  FROM st_platform.platform_presets AS preset
  ORDER BY preset.is_default DESC, preset.enabled DESC, preset.sort_order, preset.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION admin.list_platform_preset_versions(p_limit INTEGER DEFAULT 30)
RETURNS TABLE (
  platform_version BIGINT,
  preset_id UUID,
  preset_pointer TEXT,
  preset_display_name TEXT,
  created_by TEXT,
  note TEXT,
  created_at TIMESTAMPTZ
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

  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'version history limit must be between 1 and 100'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    settings.platform_version,
    CASE
      WHEN pointer.value ~ '^platform_[0-9a-fA-F-]{36}$'
        THEN substring(pointer.value FROM 10)::UUID
      ELSE NULL
    END AS preset_id,
    pointer.value AS preset_pointer,
    preset.display_name,
    settings.created_by,
    settings.note,
    settings.created_at
  FROM st_platform.platform_settings AS settings
  CROSS JOIN LATERAL (
    SELECT settings.settings_jsonb #>> '{oai_settings,preset_settings_openai}' AS value
  ) AS pointer
  LEFT JOIN st_platform.platform_presets AS preset
    ON pointer.value = 'platform_' || preset.id::TEXT
  WHERE pointer.value IS NOT NULL
  ORDER BY settings.platform_version DESC
  LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION admin.create_platform_preset(
  p_display_name TEXT,
  p_preset_payload JSONB,
  p_enabled BOOLEAN DEFAULT true,
  p_sort_order INTEGER DEFAULT NULL
) RETURNS st_platform.platform_presets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_name TEXT;
  v_order INTEGER;
  v_created st_platform.platform_presets%ROWTYPE;
BEGIN
  SELECT admin_user.* INTO v_actor
  FROM admin.admin_users AS admin_user
  WHERE admin_user.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  v_name := trim(COALESCE(p_display_name, ''));
  IF char_length(v_name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'preset display name must contain 1 to 80 characters'
      USING ERRCODE = '22023';
  END IF;
  PERFORM admin.validate_platform_preset_payload(p_preset_payload);

  IF p_sort_order IS NOT NULL AND p_sort_order < 0 THEN
    RAISE EXCEPTION 'preset sort order must not be negative'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(p_sort_order, max(preset.sort_order) + 1, 0)
  INTO v_order
  FROM st_platform.platform_presets AS preset;

  INSERT INTO st_platform.platform_presets (
    display_name, preset_payload, is_default, sort_order, enabled
  ) VALUES (
    v_name, p_preset_payload, false, v_order, COALESCE(p_enabled, true)
  )
  RETURNING * INTO v_created;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    'platform_preset.create', 'st_platform', 'platform_presets', v_created.id::TEXT,
    NULL, to_jsonb(v_created) - 'preset_payload'
  );

  RETURN v_created;
END;
$$;

CREATE OR REPLACE FUNCTION admin.update_platform_preset_metadata(
  p_preset_id UUID,
  p_display_name TEXT,
  p_sort_order INTEGER
) RETURNS st_platform.platform_presets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_before st_platform.platform_presets%ROWTYPE;
  v_after st_platform.platform_presets%ROWTYPE;
  v_name TEXT;
BEGIN
  SELECT admin_user.* INTO v_actor
  FROM admin.admin_users AS admin_user
  WHERE admin_user.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  v_name := trim(COALESCE(p_display_name, ''));
  IF char_length(v_name) NOT BETWEEN 1 AND 80 OR p_sort_order IS NULL OR p_sort_order < 0 THEN
    RAISE EXCEPTION 'invalid preset metadata' USING ERRCODE = '22023';
  END IF;

  SELECT preset.* INTO v_before
  FROM st_platform.platform_presets AS preset
  WHERE preset.id = p_preset_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform preset not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE st_platform.platform_presets
  SET display_name = v_name,
      sort_order = p_sort_order,
      updated_at = now()
  WHERE id = p_preset_id
  RETURNING * INTO v_after;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    'platform_preset.metadata_update', 'st_platform', 'platform_presets', p_preset_id::TEXT,
    to_jsonb(v_before) - 'preset_payload', to_jsonb(v_after) - 'preset_payload'
  );

  RETURN v_after;
END;
$$;

CREATE OR REPLACE FUNCTION admin.set_platform_preset_enabled(
  p_preset_id UUID,
  p_enabled BOOLEAN
) RETURNS st_platform.platform_presets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_before st_platform.platform_presets%ROWTYPE;
  v_after st_platform.platform_presets%ROWTYPE;
BEGIN
  SELECT admin_user.* INTO v_actor
  FROM admin.admin_users AS admin_user
  WHERE admin_user.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  SELECT preset.* INTO v_before
  FROM st_platform.platform_presets AS preset
  WHERE preset.id = p_preset_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform preset not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_before.is_default AND NOT COALESCE(p_enabled, false) THEN
    RAISE EXCEPTION 'the current default preset cannot be disabled'
      USING ERRCODE = '22023';
  END IF;

  UPDATE st_platform.platform_presets
  SET enabled = COALESCE(p_enabled, false),
      updated_at = now()
  WHERE id = p_preset_id
  RETURNING * INTO v_after;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    CASE WHEN v_after.enabled
      THEN 'platform_preset.enable'
      ELSE 'platform_preset.disable'
    END,
    'st_platform', 'platform_presets', p_preset_id::TEXT,
    to_jsonb(v_before) - 'preset_payload', to_jsonb(v_after) - 'preset_payload'
  );

  RETURN v_after;
END;
$$;

CREATE OR REPLACE FUNCTION admin.publish_platform_preset(
  p_display_name TEXT,
  p_preset_payload JSONB
) RETURNS st_platform.platform_presets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_name TEXT;
  v_before st_platform.platform_presets%ROWTYPE;
  v_created st_platform.platform_presets%ROWTYPE;
  v_version BIGINT;
BEGIN
  SELECT admin_user.* INTO v_actor
  FROM admin.admin_users AS admin_user
  WHERE admin_user.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  v_name := trim(COALESCE(p_display_name, ''));
  IF char_length(v_name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'preset display name must contain 1 to 80 characters'
      USING ERRCODE = '22023';
  END IF;
  PERFORM admin.validate_platform_preset_payload(p_preset_payload);

  -- Serialize default promotions so the partial unique index and version increment
  -- cannot race when two operators publish at the same time.
  PERFORM pg_advisory_xact_lock(hashtext('st_platform.platform_presets.default'));

  SELECT preset.* INTO v_before
  FROM st_platform.platform_presets AS preset
  WHERE preset.is_default
  FOR UPDATE;

  IF NOT EXISTS (SELECT 1 FROM st_platform.platform_settings) THEN
    RAISE EXCEPTION 'platform settings must be initialized before publishing a preset'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO st_platform.platform_presets (
    display_name, preset_payload, is_default, sort_order, enabled
  ) VALUES (
    v_name,
    p_preset_payload,
    true,
    COALESCE((SELECT max(preset.sort_order) + 1 FROM st_platform.platform_presets AS preset), 0),
    true
  )
  RETURNING * INTO v_created;

  SELECT max(settings.platform_version)
  INTO v_version
  FROM st_platform.platform_settings AS settings;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    'platform_preset.publish_default', 'st_platform', 'platform_presets', v_created.id::TEXT,
    CASE WHEN v_before.id IS NULL THEN NULL ELSE to_jsonb(v_before) - 'preset_payload' END,
    (to_jsonb(v_created) - 'preset_payload') || jsonb_build_object('platform_version', v_version)
  );

  RETURN v_created;
END;
$$;

REVOKE ALL ON FUNCTION admin.validate_platform_preset_payload(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.list_platform_presets()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.list_platform_preset_versions(INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.create_platform_preset(TEXT, JSONB, BOOLEAN, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.update_platform_preset_metadata(UUID, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.set_platform_preset_enabled(UUID, BOOLEAN)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.publish_platform_preset(TEXT, JSONB)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION admin.list_platform_presets()
  TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.list_platform_preset_versions(INTEGER)
  TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.create_platform_preset(TEXT, JSONB, BOOLEAN, INTEGER)
  TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.update_platform_preset_metadata(UUID, TEXT, INTEGER)
  TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.set_platform_preset_enabled(UUID, BOOLEAN)
  TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.publish_platform_preset(TEXT, JSONB)
  TO authenticated, service_role, postgres;

COMMENT ON FUNCTION admin.publish_platform_preset(TEXT, JSONB) IS
  'Publishes an immutable preset snapshot as the new platform default and advances platform_settings.';

COMMIT;
