-- Delete obsolete character layout history snapshots without changing the live layout.

BEGIN;

CREATE OR REPLACE FUNCTION admin.delete_character_layout_release(
  p_release_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_environment TEXT := admin.current_environment();
  v_release admin.character_layout_releases%ROWTYPE;
  v_current_version INTEGER;
BEGIN
  SELECT actor.* INTO v_actor
  FROM admin.admin_users AS actor
  WHERE actor.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(v_environment) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('admin.character_layout:' || v_environment));

  SELECT release.* INTO v_release
  FROM admin.character_layout_releases AS release
  WHERE release.id = p_release_id
    AND release.environment = v_environment
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'character layout release not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT state.layout_version INTO v_current_version
  FROM admin.character_layout_state AS state
  WHERE state.environment = v_environment
  FOR UPDATE;

  IF v_release.layout_version = v_current_version THEN
    RAISE EXCEPTION 'the current published character layout release cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO admin.audit_logs(
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, v_environment,
    'character.layout.release.delete',
    'admin', 'character_layout_releases', v_release.id::TEXT,
    jsonb_build_object(
      'id', v_release.id,
      'layout_version', v_release.layout_version,
      'release_kind', v_release.release_kind,
      'source_draft_id', v_release.source_draft_id,
      'rollback_target_release_id', v_release.rollback_target_release_id,
      'listed_ids', v_release.listed_ids,
      'delisted_ids', v_release.delisted_ids,
      'deleted_ids', v_release.deleted_ids,
      'released_by', v_release.released_by,
      'released_at', v_release.released_at
    ),
    jsonb_build_object('deleted', true)
  );

  DELETE FROM admin.character_layout_releases AS release
  WHERE release.id = v_release.id;
END;
$$;

REVOKE ALL ON FUNCTION admin.delete_character_layout_release(UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin.delete_character_layout_release(UUID)
  TO authenticated, service_role, postgres;

COMMIT;
