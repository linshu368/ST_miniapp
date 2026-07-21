-- Draft/publish lifecycle for the complete character lobby layout.

BEGIN;

CREATE TABLE IF NOT EXISTS admin.character_layout_state (
  environment TEXT PRIMARY KEY CHECK (environment IN ('test', 'production')),
  layout_version INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin.character_layout_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment TEXT NOT NULL CHECK (environment IN ('test', 'production')),
  listed_ids UUID[] NOT NULL DEFAULT '{}',
  delisted_ids UUID[] NOT NULL DEFAULT '{}',
  deleted_ids UUID[] NOT NULL DEFAULT '{}',
  base_layout_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_by UUID NOT NULL REFERENCES admin.admin_users(user_id),
  updated_by UUID NOT NULL REFERENCES admin.admin_users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_character_layout_one_active_draft
  ON admin.character_layout_drafts(environment)
  WHERE status = 'draft';

CREATE TABLE IF NOT EXISTS admin.character_layout_releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment TEXT NOT NULL CHECK (environment IN ('test', 'production')),
  layout_version INTEGER NOT NULL,
  listed_ids UUID[] NOT NULL,
  delisted_ids UUID[] NOT NULL,
  deleted_ids UUID[] NOT NULL,
  source_draft_id UUID REFERENCES admin.character_layout_drafts(id),
  released_by UUID NOT NULL REFERENCES admin.admin_users(user_id),
  released_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment, layout_version)
);

ALTER TABLE admin.character_layout_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin.character_layout_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin.character_layout_releases ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON admin.character_layout_state FROM PUBLIC, anon, authenticated;
REVOKE ALL ON admin.character_layout_drafts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON admin.character_layout_releases FROM PUBLIC, anon, authenticated;
GRANT ALL ON admin.character_layout_state TO service_role, postgres;
GRANT ALL ON admin.character_layout_drafts TO service_role, postgres;
GRANT ALL ON admin.character_layout_releases TO service_role, postgres;

DROP FUNCTION IF EXISTS admin.get_characters();
CREATE OR REPLACE FUNCTION admin.get_characters()
RETURNS TABLE (
  id UUID,
  name TEXT,
  description TEXT,
  avatar_url TEXT,
  tags JSONB,
  creator TEXT,
  first_mes TEXT,
  creator_notes TEXT,
  enabled BOOLEAN,
  sort_order INTEGER,
  archived_at TIMESTAMP WITHOUT TIME ZONE,
  created_at TIMESTAMP WITHOUT TIME ZONE,
  updated_at TIMESTAMP WITHOUT TIME ZONE
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
  SELECT card.id, card.name, card.description, card.avatar_url, card.tags,
         card.creator, card.first_mes, card.creator_notes, card.enabled,
         card.sort_order, card.archived_at, card.created_at, card.updated_at
  FROM miniapp.characters AS card
  ORDER BY (card.archived_at IS NOT NULL), card.enabled DESC,
           card.sort_order ASC, card.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION admin.get_character_layout()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_environment TEXT := admin.current_environment();
  v_version INTEGER;
  v_draft admin.character_layout_drafts%ROWTYPE;
  v_listed UUID[];
  v_delisted UUID[];
  v_deleted UUID[];
BEGIN
  IF NOT admin.can_access_environment(v_environment) THEN
    RAISE EXCEPTION 'admin is not permitted to access current environment'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(state.layout_version, 0) INTO v_version
  FROM admin.character_layout_state AS state
  WHERE state.environment = v_environment;
  v_version := COALESCE(v_version, 0);

  SELECT COALESCE(array_agg(card.id ORDER BY card.sort_order, card.created_at DESC), '{}')
    INTO v_listed
  FROM miniapp.characters AS card
  WHERE card.enabled AND card.archived_at IS NULL;
  SELECT COALESCE(array_agg(card.id ORDER BY card.sort_order, card.created_at DESC), '{}')
    INTO v_delisted
  FROM miniapp.characters AS card
  WHERE NOT card.enabled AND card.archived_at IS NULL;
  SELECT COALESCE(array_agg(card.id ORDER BY card.archived_at DESC, card.created_at DESC), '{}')
    INTO v_deleted
  FROM miniapp.characters AS card
  WHERE card.archived_at IS NOT NULL;

  SELECT draft.* INTO v_draft
  FROM admin.character_layout_drafts AS draft
  WHERE draft.environment = v_environment AND draft.status = 'draft'
  ORDER BY draft.updated_at DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'layout_version', v_version,
    'published', jsonb_build_object(
      'listed_ids', to_jsonb(v_listed),
      'delisted_ids', to_jsonb(v_delisted),
      'deleted_ids', to_jsonb(v_deleted)
    ),
    'draft', CASE WHEN v_draft.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_draft.id,
      'listed_ids', to_jsonb(v_draft.listed_ids),
      'delisted_ids', to_jsonb(v_draft.delisted_ids),
      'deleted_ids', to_jsonb(v_draft.deleted_ids),
      'base_layout_version', v_draft.base_layout_version,
      'updated_at', v_draft.updated_at
    ) END
  );
END;
$$;

CREATE OR REPLACE FUNCTION admin.validate_character_layout(
  p_listed_ids UUID[],
  p_delisted_ids UUID[],
  p_deleted_ids UUID[]
) RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_all UUID[] := COALESCE(p_listed_ids, '{}') || COALESCE(p_delisted_ids, '{}') ||
                  COALESCE(p_deleted_ids, '{}');
  v_character_count INTEGER;
  v_unique_count INTEGER;
BEGIN
  SELECT count(*) INTO v_character_count FROM miniapp.characters;
  SELECT count(DISTINCT item.id) INTO v_unique_count FROM unnest(v_all) AS item(id);

  IF cardinality(v_all) <> v_character_count OR v_unique_count <> v_character_count
     OR EXISTS (
       SELECT 1 FROM unnest(v_all) AS item(id)
       WHERE NOT EXISTS (SELECT 1 FROM miniapp.characters AS card WHERE card.id = item.id)
     ) THEN
    RAISE EXCEPTION 'character layout must partition every character exactly once'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION admin.save_character_layout_draft(
  p_listed_ids UUID[],
  p_delisted_ids UUID[],
  p_deleted_ids UUID[],
  p_base_layout_version INTEGER
) RETURNS admin.character_layout_drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_environment TEXT := admin.current_environment();
  v_version INTEGER;
  v_draft admin.character_layout_drafts%ROWTYPE;
BEGIN
  SELECT actor.* INTO v_actor FROM admin.admin_users AS actor WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(v_environment) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  PERFORM admin.validate_character_layout(p_listed_ids, p_delisted_ids, p_deleted_ids);
  INSERT INTO admin.character_layout_state(environment)
  VALUES (v_environment) ON CONFLICT (environment) DO NOTHING;
  SELECT state.layout_version INTO v_version
  FROM admin.character_layout_state AS state
  WHERE state.environment = v_environment;
  IF p_base_layout_version IS DISTINCT FROM v_version THEN
    RAISE EXCEPTION 'character layout version changed; refresh before saving'
      USING ERRCODE = '40001';
  END IF;

  SELECT draft.* INTO v_draft
  FROM admin.character_layout_drafts AS draft
  WHERE draft.environment = v_environment AND draft.status = 'draft'
  FOR UPDATE;

  IF FOUND THEN
    UPDATE admin.character_layout_drafts
    SET listed_ids = p_listed_ids, delisted_ids = p_delisted_ids,
        deleted_ids = p_deleted_ids, updated_by = v_actor.user_id, updated_at = now()
    WHERE id = v_draft.id RETURNING * INTO v_draft;
  ELSE
    INSERT INTO admin.character_layout_drafts(
      environment, listed_ids, delisted_ids, deleted_ids,
      base_layout_version, created_by, updated_by
    ) VALUES (
      v_environment, p_listed_ids, p_delisted_ids, p_deleted_ids,
      v_version, v_actor.user_id, v_actor.user_id
    ) RETURNING * INTO v_draft;
  END IF;

  INSERT INTO admin.audit_logs(
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, v_environment, 'character.layout.draft.save',
    'admin', 'character_layout_drafts', v_draft.id::TEXT,
    jsonb_build_object('listed_ids', p_listed_ids, 'delisted_ids', p_delisted_ids,
                       'deleted_ids', p_deleted_ids, 'base_layout_version', v_version)
  );
  RETURN v_draft;
END;
$$;

CREATE OR REPLACE FUNCTION admin.discard_character_layout_draft(p_draft_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_environment TEXT := admin.current_environment();
  v_draft admin.character_layout_drafts%ROWTYPE;
BEGIN
  SELECT actor.* INTO v_actor FROM admin.admin_users AS actor WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(v_environment) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;
  DELETE FROM admin.character_layout_drafts
  WHERE id = p_draft_id AND environment = v_environment AND status = 'draft'
  RETURNING * INTO v_draft;
  IF NOT FOUND THEN RAISE EXCEPTION 'active character layout draft not found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO admin.audit_logs(
    actor_user_id, actor_email, environment, action, schema_name, table_name, record_id
  ) VALUES (
    v_actor.user_id, v_actor.email, v_environment, 'character.layout.draft.discard',
    'admin', 'character_layout_drafts', p_draft_id::TEXT
  );
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION admin.publish_character_layout_draft(p_draft_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_environment TEXT := admin.current_environment();
  v_draft admin.character_layout_drafts%ROWTYPE;
  v_version INTEGER;
  v_before JSONB;
BEGIN
  SELECT actor.* INTO v_actor FROM admin.admin_users AS actor WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(v_environment) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('admin.character_layout:' || v_environment));
  SELECT draft.* INTO v_draft
  FROM admin.character_layout_drafts AS draft
  WHERE draft.id = p_draft_id AND draft.environment = v_environment AND draft.status = 'draft'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active character layout draft not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM admin.validate_character_layout(v_draft.listed_ids, v_draft.delisted_ids, v_draft.deleted_ids);

  INSERT INTO admin.character_layout_state(environment)
  VALUES (v_environment) ON CONFLICT (environment) DO NOTHING;
  SELECT state.layout_version INTO v_version
  FROM admin.character_layout_state AS state
  WHERE state.environment = v_environment FOR UPDATE;
  IF v_draft.base_layout_version <> v_version THEN
    RAISE EXCEPTION 'character layout version changed; refresh before publishing'
      USING ERRCODE = '40001';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
    'id', card.id, 'enabled', card.enabled, 'sort_order', card.sort_order,
    'archived_at', card.archived_at
  ) ORDER BY card.id) INTO v_before FROM miniapp.characters AS card;

  UPDATE miniapp.characters AS card
  SET enabled = true, archived_at = NULL, sort_order = ordered.position - 1,
      updated_at = timezone('Asia/Shanghai', now())
  FROM unnest(v_draft.listed_ids) WITH ORDINALITY AS ordered(id, position)
  WHERE card.id = ordered.id;

  UPDATE miniapp.characters AS card
  SET enabled = false, archived_at = NULL,
      updated_at = timezone('Asia/Shanghai', now())
  WHERE card.id = ANY(v_draft.delisted_ids);

  UPDATE miniapp.characters AS card
  SET enabled = false,
      archived_at = COALESCE(card.archived_at, timezone('Asia/Shanghai', now())),
      updated_at = timezone('Asia/Shanghai', now())
  WHERE card.id = ANY(v_draft.deleted_ids);

  v_version := v_version + 1;
  UPDATE admin.character_layout_state
  SET layout_version = v_version, updated_at = now()
  WHERE environment = v_environment;
  UPDATE admin.character_layout_drafts
  SET status = 'published', published_at = now(), updated_at = now()
  WHERE id = v_draft.id;
  INSERT INTO admin.character_layout_releases(
    environment, layout_version, listed_ids, delisted_ids, deleted_ids,
    source_draft_id, released_by
  ) VALUES (
    v_environment, v_version, v_draft.listed_ids, v_draft.delisted_ids,
    v_draft.deleted_ids, v_draft.id, v_actor.user_id
  );
  INSERT INTO admin.audit_logs(
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, v_environment, 'character.layout.publish',
    'miniapp', 'characters', v_version::TEXT, v_before,
    jsonb_build_object('layout_version', v_version, 'listed_ids', v_draft.listed_ids,
                       'delisted_ids', v_draft.delisted_ids, 'deleted_ids', v_draft.deleted_ids)
  );
  RETURN v_version;
END;
$$;

REVOKE ALL ON FUNCTION admin.validate_character_layout(UUID[], UUID[], UUID[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.get_character_layout() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.save_character_layout_draft(UUID[], UUID[], UUID[], INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.discard_character_layout_draft(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.publish_character_layout_draft(UUID) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION admin.get_characters() TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.get_character_layout() TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.save_character_layout_draft(UUID[], UUID[], UUID[], INTEGER) TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.discard_character_layout_draft(UUID) TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.publish_character_layout_draft(UUID) TO authenticated, service_role, postgres;

COMMIT;
