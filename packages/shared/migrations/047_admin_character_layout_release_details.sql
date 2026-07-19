-- Detailed character layout release metadata and history payloads.

BEGIN;

ALTER TABLE admin.character_layout_releases
  ADD COLUMN IF NOT EXISTS release_kind TEXT NOT NULL DEFAULT 'publish',
  ADD COLUMN IF NOT EXISTS rollback_target_release_id UUID;

UPDATE admin.character_layout_releases
SET release_kind = CASE
  WHEN source_draft_id IS NOT NULL THEN 'publish'
  WHEN layout_version = 0 THEN 'baseline'
  ELSE 'rollback'
END
WHERE release_kind = 'publish' AND source_draft_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'character_layout_releases_release_kind_check'
      AND conrelid = 'admin.character_layout_releases'::regclass
  ) THEN
    ALTER TABLE admin.character_layout_releases
      ADD CONSTRAINT character_layout_releases_release_kind_check
      CHECK (release_kind IN ('baseline', 'publish', 'rollback'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'character_layout_releases_rollback_target_fkey'
      AND conrelid = 'admin.character_layout_releases'::regclass
  ) THEN
    ALTER TABLE admin.character_layout_releases
      ADD CONSTRAINT character_layout_releases_rollback_target_fkey
      FOREIGN KEY (rollback_target_release_id)
      REFERENCES admin.character_layout_releases(id)
      ON DELETE SET NULL;
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS admin.list_character_layout_releases(INTEGER);
CREATE FUNCTION admin.list_character_layout_releases(p_limit INTEGER DEFAULT 30)
RETURNS TABLE (
  id UUID,
  layout_version INTEGER,
  release_kind TEXT,
  source_draft_id UUID,
  rollback_target_release_id UUID,
  rollback_target_version INTEGER,
  listed_ids UUID[],
  delisted_ids UUID[],
  deleted_ids UUID[],
  listed_count INTEGER,
  delisted_count INTEGER,
  deleted_count INTEGER,
  released_by_email TEXT,
  released_by_name TEXT,
  released_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_environment TEXT := admin.current_environment();
BEGIN
  IF NOT admin.can_access_environment(v_environment) THEN
    RAISE EXCEPTION 'admin is not permitted to access current environment'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT release.id,
         release.layout_version,
         release.release_kind,
         release.source_draft_id,
         release.rollback_target_release_id,
         target.layout_version,
         release.listed_ids,
         release.delisted_ids,
         release.deleted_ids,
         cardinality(release.listed_ids),
         cardinality(release.delisted_ids),
         cardinality(release.deleted_ids),
         actor.email,
         actor.display_name,
         release.released_at
  FROM admin.character_layout_releases AS release
  LEFT JOIN admin.character_layout_releases AS target
    ON target.id = release.rollback_target_release_id
  LEFT JOIN admin.admin_users AS actor ON actor.user_id = release.released_by
  WHERE release.environment = v_environment
  ORDER BY release.layout_version DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
END;
$$;

CREATE OR REPLACE FUNCTION admin.rollback_character_layout_release(
  p_release_id UUID,
  p_expected_layout_version INTEGER
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_environment TEXT := admin.current_environment();
  v_target admin.character_layout_releases%ROWTYPE;
  v_version INTEGER;
  v_before JSONB;
BEGIN
  SELECT actor.* INTO v_actor
  FROM admin.admin_users AS actor
  WHERE actor.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(v_environment) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('admin.character_layout:' || v_environment));

  IF EXISTS (
    SELECT 1
    FROM admin.character_layout_drafts AS draft
    WHERE draft.environment = v_environment AND draft.status = 'draft'
  ) THEN
    RAISE EXCEPTION 'discard or publish the active character layout draft before rollback'
      USING ERRCODE = '55000';
  END IF;

  SELECT release.* INTO v_target
  FROM admin.character_layout_releases AS release
  WHERE release.id = p_release_id AND release.environment = v_environment;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'character layout release not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT state.layout_version INTO v_version
  FROM admin.character_layout_state AS state
  WHERE state.environment = v_environment
  FOR UPDATE;

  IF p_expected_layout_version IS DISTINCT FROM v_version THEN
    RAISE EXCEPTION 'character layout version changed; refresh before rollback'
      USING ERRCODE = '40001';
  END IF;

  PERFORM admin.validate_character_layout(
    v_target.listed_ids,
    v_target.delisted_ids,
    v_target.deleted_ids
  );

  SELECT jsonb_build_object(
    'layout_version', v_version,
    'listed_ids', layout.listed_ids,
    'delisted_ids', layout.delisted_ids,
    'deleted_ids', layout.deleted_ids
  ) INTO v_before
  FROM (
    SELECT
      COALESCE(array_agg(card.id ORDER BY card.sort_order, card.created_at DESC)
        FILTER (WHERE card.enabled AND card.archived_at IS NULL), '{}') AS listed_ids,
      COALESCE(array_agg(card.id ORDER BY card.sort_order, card.created_at DESC)
        FILTER (WHERE NOT card.enabled AND card.archived_at IS NULL), '{}') AS delisted_ids,
      COALESCE(array_agg(card.id ORDER BY card.archived_at DESC, card.created_at DESC)
        FILTER (WHERE card.archived_at IS NOT NULL), '{}') AS deleted_ids
    FROM miniapp.characters AS card
  ) AS layout;

  UPDATE miniapp.characters AS card
  SET enabled = true,
      archived_at = NULL,
      sort_order = ordered.position - 1,
      updated_at = timezone('Asia/Shanghai', now())
  FROM unnest(v_target.listed_ids) WITH ORDINALITY AS ordered(id, position)
  WHERE card.id = ordered.id;

  UPDATE miniapp.characters AS card
  SET enabled = false,
      archived_at = NULL,
      updated_at = timezone('Asia/Shanghai', now())
  WHERE card.id = ANY(v_target.delisted_ids);

  UPDATE miniapp.characters AS card
  SET enabled = false,
      archived_at = COALESCE(card.archived_at, timezone('Asia/Shanghai', now())),
      updated_at = timezone('Asia/Shanghai', now())
  WHERE card.id = ANY(v_target.deleted_ids);

  v_version := v_version + 1;
  UPDATE admin.character_layout_state
  SET layout_version = v_version, updated_at = now()
  WHERE environment = v_environment;

  INSERT INTO admin.character_layout_releases(
    environment, layout_version, release_kind,
    listed_ids, delisted_ids, deleted_ids,
    source_draft_id, rollback_target_release_id, released_by
  ) VALUES (
    v_environment, v_version, 'rollback',
    v_target.listed_ids, v_target.delisted_ids, v_target.deleted_ids,
    NULL, v_target.id, v_actor.user_id
  );

  INSERT INTO admin.audit_logs(
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, v_environment, 'character.layout.rollback',
    'miniapp', 'characters', p_release_id::TEXT, v_before,
    jsonb_build_object(
      'layout_version', v_version,
      'rolled_back_release_id', p_release_id,
      'rolled_back_layout_version', v_target.layout_version,
      'listed_ids', v_target.listed_ids,
      'delisted_ids', v_target.delisted_ids,
      'deleted_ids', v_target.deleted_ids
    )
  );

  RETURN v_version;
END;
$$;

REVOKE ALL ON FUNCTION admin.list_character_layout_releases(INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin.list_character_layout_releases(INTEGER)
  TO authenticated, service_role, postgres;

COMMIT;
