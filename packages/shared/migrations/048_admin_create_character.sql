-- Draft-safe character creation for the Admin platform.

BEGIN;

CREATE OR REPLACE FUNCTION admin.create_character(
  p_name TEXT,
  p_description TEXT DEFAULT '',
  p_avatar_url TEXT DEFAULT '',
  p_tags JSONB DEFAULT '[]'::JSONB,
  p_creator TEXT DEFAULT '',
  p_first_mes TEXT DEFAULT '',
  p_creator_notes TEXT DEFAULT '',
  p_personality TEXT DEFAULT '',
  p_scenario TEXT DEFAULT '',
  p_system_prompt TEXT DEFAULT '',
  p_mes_example TEXT DEFAULT ''
) RETURNS miniapp.characters
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_environment TEXT := admin.current_environment();
  v_character miniapp.characters%ROWTYPE;
  v_next_order INTEGER;
  v_now TIMESTAMP WITHOUT TIME ZONE := timezone('Asia/Shanghai', now());
BEGIN
  SELECT actor.* INTO v_actor
  FROM admin.admin_users AS actor
  WHERE actor.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(v_environment) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  p_name := btrim(COALESCE(p_name, ''));
  p_description := btrim(COALESCE(p_description, ''));
  p_avatar_url := btrim(COALESCE(p_avatar_url, ''));
  p_creator := btrim(COALESCE(p_creator, ''));

  IF length(p_name) < 1 OR length(p_name) > 120 THEN
    RAISE EXCEPTION 'character name must contain 1 to 120 characters'
      USING ERRCODE = '22023';
  END IF;
  IF length(p_description) > 4000 OR length(COALESCE(p_first_mes, '')) > 20000
     OR length(COALESCE(p_creator_notes, '')) > 20000
     OR length(COALESCE(p_personality, '')) > 20000
     OR length(COALESCE(p_scenario, '')) > 20000
     OR length(COALESCE(p_system_prompt, '')) > 30000
     OR length(COALESCE(p_mes_example, '')) > 30000 THEN
    RAISE EXCEPTION 'character text field exceeds the allowed length'
      USING ERRCODE = '22023';
  END IF;
  IF p_avatar_url <> '' AND p_avatar_url !~* '^https://[^[:space:]]+$' THEN
    RAISE EXCEPTION 'avatar URL must be an HTTPS URL' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(COALESCE(p_tags, '[]'::JSONB)) IS DISTINCT FROM 'array'
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(p_tags, '[]'::JSONB)) AS tag(value)
       WHERE jsonb_typeof(tag.value) IS DISTINCT FROM 'string'
          OR length(btrim(tag.value #>> '{}')) > 40
     ) THEN
    RAISE EXCEPTION 'tags must be an array of strings up to 40 characters'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('admin.character_layout:' || v_environment));
  SELECT COALESCE(max(card.sort_order), -1) + 1 INTO v_next_order
  FROM miniapp.characters AS card;

  INSERT INTO miniapp.characters(
    name, description, avatar_url, tags, creator, first_mes, creator_notes,
    personality, scenario, system_prompt, mes_example,
    enabled, archived_at, sort_order, spec, spec_version, raw_card,
    created_at, updated_at
  ) VALUES (
    p_name, p_description, p_avatar_url, COALESCE(p_tags, '[]'::JSONB),
    p_creator, COALESCE(p_first_mes, ''), COALESCE(p_creator_notes, ''),
    COALESCE(p_personality, ''), COALESCE(p_scenario, ''),
    COALESCE(p_system_prompt, ''), COALESCE(p_mes_example, ''),
    false, NULL, v_next_order, 'chara_card_v2', '2.0',
    jsonb_build_object(
      'spec', 'chara_card_v2',
      'spec_version', '2.0',
      'data', jsonb_build_object(
        'name', p_name,
        'description', p_description,
        'personality', COALESCE(p_personality, ''),
        'scenario', COALESCE(p_scenario, ''),
        'first_mes', COALESCE(p_first_mes, ''),
        'mes_example', COALESCE(p_mes_example, ''),
        'creator_notes', COALESCE(p_creator_notes, ''),
        'system_prompt', COALESCE(p_system_prompt, ''),
        'tags', COALESCE(p_tags, '[]'::JSONB),
        'creator', p_creator
      )
    ),
    v_now, v_now
  ) RETURNING * INTO v_character;

  UPDATE admin.character_layout_drafts AS draft
  SET delisted_ids = draft.delisted_ids || v_character.id,
      updated_by = v_actor.user_id,
      updated_at = now()
  WHERE draft.environment = v_environment
    AND draft.status = 'draft'
    AND NOT v_character.id = ANY(
      draft.listed_ids || draft.delisted_ids || draft.deleted_ids
    );

  INSERT INTO admin.audit_logs(
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, v_environment, 'character.create',
    'miniapp', 'characters', v_character.id::TEXT,
    jsonb_build_object(
      'id', v_character.id,
      'name', v_character.name,
      'enabled', v_character.enabled,
      'sort_order', v_character.sort_order,
      'avatar_url', v_character.avatar_url,
      'draft_state', 'delisted'
    )
  );

  RETURN v_character;
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
  v_draft admin.character_layout_drafts%ROWTYPE;
  v_listed_ids UUID[];
  v_delisted_ids UUID[];
  v_deleted_ids UUID[];
  v_missing_ids UUID[];
  v_version INTEGER;
BEGIN
  SELECT actor.* INTO v_actor
  FROM admin.admin_users AS actor
  WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(v_environment) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM admin.character_layout_drafts AS draft
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

  v_listed_ids := v_target.listed_ids;
  v_delisted_ids := v_target.delisted_ids;
  v_deleted_ids := v_target.deleted_ids;
  SELECT COALESCE(array_agg(card.id ORDER BY card.created_at), '{}') INTO v_missing_ids
  FROM miniapp.characters AS card
  WHERE NOT card.id = ANY(v_listed_ids || v_delisted_ids || v_deleted_ids);
  v_delisted_ids := v_delisted_ids || v_missing_ids;

  SELECT * INTO v_draft
  FROM admin.save_character_layout_draft(
    v_listed_ids, v_delisted_ids, v_deleted_ids, p_expected_layout_version
  );
  v_version := admin.publish_character_layout_draft(v_draft.id);

  UPDATE admin.character_layout_releases
  SET release_kind = 'rollback',
      source_draft_id = NULL,
      rollback_target_release_id = v_target.id
  WHERE environment = v_environment AND layout_version = v_version;

  INSERT INTO admin.audit_logs(
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, v_environment, 'character.layout.rollback',
    'miniapp', 'characters', p_release_id::TEXT,
    jsonb_build_object(
      'layout_version', v_version,
      'rolled_back_release_id', p_release_id,
      'rolled_back_layout_version', v_target.layout_version,
      'later_characters_preserved_as_delisted', v_missing_ids
    )
  );
  RETURN v_version;
END;
$$;

REVOKE ALL ON FUNCTION admin.create_character(
  TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION admin.create_character(
  TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO authenticated, service_role, postgres;

COMMIT;
