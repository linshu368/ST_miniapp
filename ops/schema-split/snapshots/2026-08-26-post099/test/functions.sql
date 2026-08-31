-- ==================== admin.archive_character(p_character_id uuid) ====================
CREATE OR REPLACE FUNCTION admin.archive_character(p_character_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_before app_core.characters%ROWTYPE;
  v_after app_core.characters%ROWTYPE;
BEGIN
  SELECT au.* INTO v_actor
  FROM admin.admin_users AS au
  WHERE au.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  SELECT card.* INTO v_before
  FROM app_core.characters AS card
  WHERE card.id = p_character_id AND card.archived_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active character not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE app_core.characters
  SET enabled = false,
      archived_at = timezone('Asia/Shanghai'::TEXT, now()),
      updated_at = timezone('Asia/Shanghai'::TEXT, now())
  WHERE id = p_character_id
  RETURNING * INTO v_after;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    'character.archive', 'app_core', 'characters', p_character_id::TEXT,
    to_jsonb(v_before), to_jsonb(v_after)
  );
  RETURN true;
END;
$function$


-- ==================== admin.can_access_environment(p_environment text) ====================
CREATE OR REPLACE FUNCTION admin.can_access_environment(p_environment text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM admin.admin_users AS au
    WHERE au.user_id = auth.uid()
      AND p_environment = admin.current_environment()
      AND (
        (p_environment = 'test' AND au.can_access_test)
        OR (p_environment = 'production' AND au.can_access_prod)
      )
  );
$function$


-- ==================== admin.create_announcement(p_category text, p_title text, p_body text, p_sort_order integer, p_is_published boolean) ====================
CREATE OR REPLACE FUNCTION admin.create_announcement(p_category text, p_title text, p_body text, p_sort_order integer DEFAULT 0, p_is_published boolean DEFAULT false)
 RETURNS miniapp_features.notifications
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_created miniapp_features.notifications%ROWTYPE;
BEGIN
  SELECT actor.* INTO v_actor FROM admin.admin_users AS actor WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO miniapp_features.notifications (
    scope, category, title, body, sort_order, is_published, published_at, created_by
  ) VALUES (
    'official', p_category, trim(p_title), trim(p_body), COALESCE(p_sort_order, 0),
    COALESCE(p_is_published, false),
    CASE WHEN COALESCE(p_is_published, false) THEN now() ELSE NULL END,
    v_actor.user_id
  ) RETURNING * INTO v_created;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name, table_name,
    record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    'announcement.create', 'miniapp_features', 'notifications', v_created.id::TEXT,
    NULL, to_jsonb(v_created)
  );
  RETURN v_created;
END;
$function$


-- ==================== admin.create_character(p_name text, p_description text, p_avatar_url text, p_tags jsonb, p_creator text, p_first_mes text, p_creator_notes text, p_personality text, p_scenario text, p_system_prompt text, p_mes_example text) ====================
CREATE OR REPLACE FUNCTION admin.create_character(p_name text, p_description text DEFAULT ''::text, p_avatar_url text DEFAULT ''::text, p_tags jsonb DEFAULT '[]'::jsonb, p_creator text DEFAULT ''::text, p_first_mes text DEFAULT ''::text, p_creator_notes text DEFAULT ''::text, p_personality text DEFAULT ''::text, p_scenario text DEFAULT ''::text, p_system_prompt text DEFAULT ''::text, p_mes_example text DEFAULT ''::text)
 RETURNS app_core.characters
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_environment TEXT := admin.current_environment();
  v_character app_core.characters%ROWTYPE;
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
  FROM app_core.characters AS card;

  INSERT INTO app_core.characters(
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
    'app_core', 'characters', v_character.id::TEXT,
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
$function$


-- ==================== admin.current_environment() ====================
CREATE OR REPLACE FUNCTION admin.current_environment()
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_environment TEXT;
BEGIN
  SELECT config.environment
  INTO v_environment
  FROM admin.environment_config AS config
  WHERE config.id = 1;

  IF NOT FOUND OR v_environment NOT IN ('test', 'production') THEN
    RAISE EXCEPTION 'admin environment is not configured'
      USING
        ERRCODE = '55000',
        HINT = 'Bootstrap admin.environment_config as service_role or postgres.';
  END IF;

  RETURN v_environment;
END;
$function$


-- ==================== admin.delete_announcement(p_id uuid) ====================
CREATE OR REPLACE FUNCTION admin.delete_announcement(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_before miniapp_features.notifications%ROWTYPE;
BEGIN
  SELECT actor.* INTO v_actor FROM admin.admin_users AS actor WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  UPDATE miniapp_features.notifications
  SET deleted_at = now(), is_published = false, updated_at = now()
  WHERE id = p_id AND scope = 'official' AND user_id IS NULL AND deleted_at IS NULL
  RETURNING * INTO v_before;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'announcement not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name, table_name,
    record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    'announcement.delete', 'miniapp_features', 'notifications', p_id::TEXT,
    to_jsonb(v_before), NULL
  );
END;
$function$


-- ==================== admin.delete_character_layout_release(p_release_id uuid) ====================
CREATE OR REPLACE FUNCTION admin.delete_character_layout_release(p_release_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
$function$


-- ==================== admin.discard_character_layout_draft(p_draft_id uuid) ====================
CREATE OR REPLACE FUNCTION admin.discard_character_layout_draft(p_draft_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
$function$


-- ==================== admin.discard_config_draft(p_draft_id uuid) ====================
CREATE OR REPLACE FUNCTION admin.discard_config_draft(p_draft_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_draft admin.config_drafts%ROWTYPE;
BEGIN
  SELECT admin_user.* INTO v_actor
  FROM admin.admin_users AS admin_user
  WHERE admin_user.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator') THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  SELECT draft.* INTO v_draft
  FROM admin.config_drafts AS draft
  WHERE draft.id = p_draft_id
    AND draft.status = 'draft'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active draft not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.environment <> admin.current_environment()
     OR (v_draft.environment = 'test' AND NOT v_actor.can_access_test)
     OR (v_draft.environment = 'production' AND NOT v_actor.can_access_prod) THEN
    RAISE EXCEPTION 'admin is not permitted to access requested environment'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM admin.config_drafts
  WHERE id = v_draft.id;

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
    v_draft.environment,
    'config.draft.discard',
    'admin',
    'config_drafts',
    v_draft.id::TEXT,
    to_jsonb(v_draft),
    NULL
  );

  RETURN true;
END;
$function$


-- ==================== admin.get_character_layout() ====================
CREATE OR REPLACE FUNCTION admin.get_character_layout()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
  FROM app_core.characters AS card
  WHERE card.enabled AND card.archived_at IS NULL AND NOT card.is_test;
  SELECT COALESCE(array_agg(card.id ORDER BY card.sort_order, card.created_at DESC), '{}')
    INTO v_delisted
  FROM app_core.characters AS card
  WHERE NOT card.enabled AND card.archived_at IS NULL AND NOT card.is_test;
  SELECT COALESCE(array_agg(card.id ORDER BY card.archived_at DESC, card.created_at DESC), '{}')
    INTO v_deleted
  FROM app_core.characters AS card
  WHERE card.archived_at IS NOT NULL AND NOT card.is_test;

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
$function$


-- ==================== admin.get_characters() ====================
CREATE OR REPLACE FUNCTION admin.get_characters()
 RETURNS TABLE(id uuid, name text, description text, avatar_url text, tags jsonb, creator text, first_mes text, creator_notes text, enabled boolean, sort_order integer, archived_at timestamp without time zone, created_at timestamp without time zone, updated_at timestamp without time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'admin is not permitted to access current environment'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT card.id, card.name, card.description, card.avatar_url, card.tags,
         card.creator, card.first_mes, card.creator_notes, card.enabled,
         card.sort_order, card.archived_at, card.created_at, card.updated_at
  FROM app_core.characters AS card
  WHERE NOT card.is_test
  ORDER BY (card.archived_at IS NOT NULL), card.enabled DESC,
           card.sort_order ASC, card.created_at DESC;
END;
$function$


-- ==================== admin.get_managed_configs() ====================
CREATE OR REPLACE FUNCTION admin.get_managed_configs()
 RETURNS TABLE(key text, value jsonb, description text, version integer, updated_at timestamp with time zone, text_value text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor        admin.admin_users%ROWTYPE;
  v_environment TEXT;
BEGIN
  SELECT au.*
  INTO v_actor
  FROM admin.admin_users AS au
  WHERE au.user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'registered admin required'
      USING ERRCODE = '42501';
  END IF;

  v_environment := admin.current_environment();

  IF (v_environment = 'test' AND NOT v_actor.can_access_test)
     OR (v_environment = 'production' AND NOT v_actor.can_access_prod) THEN
    RAISE EXCEPTION 'admin is not permitted to access configured environment: %', v_environment
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT rc.*
  FROM app_core.runtime_config AS rc
  WHERE admin.is_managed_config_key(rc.key)
  ORDER BY rc.key;
END;
$function$


-- ==================== admin.grant_user_credits(p_user_id uuid, p_amount integer, p_title text, p_body text, p_request_id uuid, p_allow_duplicate boolean) ====================
CREATE OR REPLACE FUNCTION admin.grant_user_credits(p_user_id uuid, p_amount integer, p_title text, p_body text, p_request_id uuid, p_allow_duplicate boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_wallet billing.user_wallets%ROWTYPE;
  v_existing billing.wallet_ledger%ROWTYPE;
  v_recent billing.wallet_ledger%ROWTYPE;
  v_notification miniapp_features.notifications%ROWTYPE;
  v_title TEXT := trim(COALESCE(p_title, ''));
  v_body TEXT := trim(COALESCE(p_body, ''));
BEGIN
  SELECT actor.* INTO v_actor FROM admin.admin_users AS actor WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'grant request id is required' USING ERRCODE = '22023';
  END IF;
  -- 上限只是防手滑的硬闸，运营侧的额度规则本次不做。
  IF p_amount IS NULL OR p_amount < 1 OR p_amount > 100000 THEN
    RAISE EXCEPTION 'grant amount must be between 1 and 100000' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_title) < 1 OR char_length(v_title) > 120 THEN
    RAISE EXCEPTION 'notification title must be 1-120 chars' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_body) < 1 OR char_length(v_body) > 4000 THEN
    RAISE EXCEPTION 'notification body must be 1-4000 chars' USING ERRCODE = '22023';
  END IF;

  SELECT ledger.* INTO v_existing
  FROM billing.wallet_ledger AS ledger
  WHERE ledger.reference_type = 'outreach_grant'
    AND ledger.reference_id = p_request_id::TEXT;
  IF FOUND THEN
    SELECT wallet.* INTO v_wallet
    FROM billing.user_wallets AS wallet
    WHERE wallet.user_id = v_existing.user_id;
    RETURN jsonb_build_object(
      'granted', false,
      'blocked', false,
      'user_id', v_existing.user_id,
      'amount', v_existing.amount,
      'main_credits', v_wallet.main_credits,
      'bonus_credits', v_wallet.bonus_credits,
      'total_credits', v_wallet.total_credits,
      'notification_id', v_existing.metadata ->> 'notification_id',
      'granted_at', v_existing.created_at
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM app_core.users AS app_user WHERE app_user.id = p_user_id) THEN
    RAISE EXCEPTION 'user not found' USING ERRCODE = 'P0002';
  END IF;

  -- request id 只能挡住「同一次操作」的重试。换台机器、换个浏览器重来会带新的 id，
  -- 所以这里再按「同一人同一金额」加一道短时窗软拦截：不报错，回一个待确认状态，
  -- 由客服显式放行。PRD 允许短时间内重复赠送，因此只能软拦不能硬禁。
  IF NOT COALESCE(p_allow_duplicate, false) THEN
    SELECT ledger.* INTO v_recent
    FROM billing.wallet_ledger AS ledger
    WHERE ledger.user_id = p_user_id
      AND ledger.reference_type = 'outreach_grant'
      AND ledger.amount = p_amount
      AND ledger.created_at > now() - interval '10 minutes'
    ORDER BY ledger.created_at DESC
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'granted', false,
        'blocked', true,
        'reason', 'duplicate_window',
        'user_id', p_user_id,
        'amount', p_amount,
        'last_amount', v_recent.amount,
        'last_granted_at', v_recent.created_at
      );
    END IF;
  END IF;

  INSERT INTO billing.user_wallets (user_id) VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT wallet.* INTO v_wallet
  FROM billing.user_wallets AS wallet
  WHERE wallet.user_id = p_user_id
  FOR UPDATE;

  -- 与新用户赠送、签到、许愿奖励一致，运营赠送只加 bonus_credits。
  UPDATE billing.user_wallets
  SET bonus_credits = bonus_credits + p_amount, updated_at = now()
  WHERE user_id = p_user_id
  RETURNING * INTO v_wallet;

  INSERT INTO miniapp_features.notifications (
    scope, category, title, body, user_id, is_published, published_at, created_by
  ) VALUES (
    'official', 'activity', v_title, v_body, p_user_id, true, now(), v_actor.user_id
  ) RETURNING * INTO v_notification;

  INSERT INTO billing.wallet_ledger (
    user_id, entry_type, amount, main_delta, bonus_delta,
    balance_main, balance_bonus, reference_type, reference_id, metadata
  ) VALUES (
    p_user_id, 'adjustment', p_amount, 0, p_amount,
    v_wallet.main_credits, v_wallet.bonus_credits, 'outreach_grant', p_request_id::TEXT,
    jsonb_build_object(
      'reason', 'outreach_grant',
      'notification_id', v_notification.id,
      'actor_user_id', v_actor.user_id,
      'actor_email', v_actor.email
    )
  );

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name, table_name,
    record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    'wallet.outreach_grant', 'billing', 'user_wallets', p_user_id::TEXT,
    NULL,
    jsonb_build_object(
      'amount', p_amount,
      'request_id', p_request_id,
      'notification_id', v_notification.id,
      'balance_bonus', v_wallet.bonus_credits
    )
  );

  RETURN jsonb_build_object(
    'granted', true,
    'blocked', false,
    'user_id', p_user_id,
    'amount', p_amount,
    'main_credits', v_wallet.main_credits,
    'bonus_credits', v_wallet.bonus_credits,
    'total_credits', v_wallet.total_credits,
    'notification_id', v_notification.id,
    'granted_at', v_notification.published_at
  );
END;
$function$


-- ==================== admin.is_managed_config_key(p_config_key text) ====================
CREATE OR REPLACE FUNCTION admin.is_managed_config_key(p_config_key text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT p_config_key IN (
    'miniapp_new_user_signup_bonus_credits',
    'miniapp_daily_checkin_bonus_credits',
    'miniapp_character_free_chat_quota_limit',
    'miniapp_payment_plans',
    'miniapp_recharge_page_config',
    'miniapp_payment_prompt_dialog_config',
    'miniapp_free_quota_exhausted_dialog_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id',
    'system_instructions',
    'pref_word_count_tiers',
    'lobby_ranking_params',
    'lobby_pinned_characters',
    'voice_billing_enabled',
    'voice_generation_credits',
    'voice_max_spoken_chars',
    'voice_price_label',
    'voice_over_limit_hint',
    'voice_draft_failed_hint',
    'voice_tts_failed_hint'
  );
$function$


-- ==================== admin.is_registered_admin() ====================
CREATE OR REPLACE FUNCTION admin.is_registered_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_environment TEXT;
BEGIN
  v_environment := admin.current_environment();

  RETURN EXISTS (
    SELECT 1
    FROM admin.admin_users AS au
    WHERE au.user_id = auth.uid()
      AND (
        (v_environment = 'test' AND au.can_access_test)
        OR (v_environment = 'production' AND au.can_access_prod)
      )
  );
END;
$function$


-- ==================== admin.list_announcements() ====================
CREATE OR REPLACE FUNCTION admin.list_announcements()
 RETURNS SETOF miniapp_features.notifications
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'admin is not permitted to access current environment'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT notification.*
  FROM miniapp_features.notifications AS notification
  WHERE notification.scope = 'official'
    AND notification.user_id IS NULL
    AND notification.deleted_at IS NULL
  ORDER BY notification.sort_order, notification.created_at DESC;
END;
$function$


-- ==================== admin.list_character_layout_releases(p_limit integer) ====================
CREATE OR REPLACE FUNCTION admin.list_character_layout_releases(p_limit integer DEFAULT 30)
 RETURNS TABLE(id uuid, layout_version integer, release_kind text, source_draft_id uuid, rollback_target_release_id uuid, rollback_target_version integer, listed_ids uuid[], delisted_ids uuid[], deleted_ids uuid[], listed_count integer, delisted_count integer, deleted_count integer, released_by_email text, released_by_name text, released_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
$function$


-- ==================== admin.lookup_user_for_credit_grant(p_identifier text) ====================
CREATE OR REPLACE FUNCTION admin.lookup_user_for_credit_grant(p_identifier text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_identifier TEXT := trim(COALESCE(p_identifier, ''));
  v_user app_core.users%ROWTYPE;
  v_user_id UUID;
BEGIN
  SELECT actor.* INTO v_actor FROM admin.admin_users AS actor WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  IF v_identifier = '' THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  BEGIN
    v_user_id := v_identifier::UUID;
  EXCEPTION WHEN invalid_text_representation THEN
    v_user_id := NULL;
  END;

  IF v_user_id IS NOT NULL THEN
    SELECT app_user.* INTO v_user
    FROM app_core.users AS app_user
    WHERE app_user.id = v_user_id;
  ELSE
    SELECT app_user.* INTO v_user
    FROM app_core.users AS app_user
    WHERE app_user.tg_id = v_identifier;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'found', true,
      'user_id', v_user.id,
      'tg_id', v_user.tg_id,
      'display_name', COALESCE(settings.display_name, settings.tg_first_name),
      'tg_username', settings.tg_username,
      'main_credits', COALESCE(wallet.main_credits, 0),
      'bonus_credits', COALESCE(wallet.bonus_credits, 0),
      'total_credits', COALESCE(wallet.total_credits, 0),
      'created_at', v_user.created_at,
      -- 客服在发放前能看到这个人最近拿过什么，避免凭记忆判断是否已发过。
      'recent_grants', COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object('amount', recent.amount, 'created_at', recent.created_at)
            ORDER BY recent.created_at DESC
          )
          FROM (
            SELECT ledger.amount, ledger.created_at
            FROM billing.wallet_ledger AS ledger
            WHERE ledger.user_id = v_user.id
              AND ledger.reference_type = 'outreach_grant'
            ORDER BY ledger.created_at DESC
            LIMIT 5
          ) AS recent
        ),
        '[]'::jsonb
      )
    )
    FROM (SELECT 1) AS anchor
    LEFT JOIN app_core.miniapp_user_settings AS settings ON settings.user_id = v_user.id
    LEFT JOIN billing.user_wallets AS wallet ON wallet.user_id = v_user.id
  );
END;
$function$


-- ==================== admin.publish_character_layout_draft(p_draft_id uuid) ====================
CREATE OR REPLACE FUNCTION admin.publish_character_layout_draft(p_draft_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
  ) ORDER BY card.id) INTO v_before FROM app_core.characters AS card;

  UPDATE app_core.characters AS card
  SET enabled = true, archived_at = NULL, sort_order = ordered.position - 1,
      updated_at = timezone('Asia/Shanghai', now())
  FROM unnest(v_draft.listed_ids) WITH ORDINALITY AS ordered(id, position)
  WHERE card.id = ordered.id;

  UPDATE app_core.characters AS card
  SET enabled = false, archived_at = NULL,
      updated_at = timezone('Asia/Shanghai', now())
  WHERE card.id = ANY(v_draft.delisted_ids);

  UPDATE app_core.characters AS card
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
    'app_core', 'characters', v_version::TEXT, v_before,
    jsonb_build_object('layout_version', v_version, 'listed_ids', v_draft.listed_ids,
                       'delisted_ids', v_draft.delisted_ids, 'deleted_ids', v_draft.deleted_ids)
  );
  RETURN v_version;
END;
$function$


-- ==================== admin.publish_config_draft(p_draft_id uuid) ====================
CREATE OR REPLACE FUNCTION admin.publish_config_draft(p_draft_id uuid)
 RETURNS admin.config_releases
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor        admin.admin_users%ROWTYPE;
  v_environment  TEXT;
  v_draft        admin.config_drafts%ROWTYPE;
  v_runtime      app_core.runtime_config%ROWTYPE;
  v_before       JSONB;
  v_release      admin.config_releases%ROWTYPE;
BEGIN
  SELECT au.*
  INTO v_actor
  FROM admin.admin_users AS au
  WHERE au.user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'registered admin required'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor.role NOT IN ('owner', 'operator') THEN
    RAISE EXCEPTION 'viewer accounts are read-only'
      USING ERRCODE = '42501';
  END IF;

  v_environment := admin.current_environment();

  SELECT config_draft.*
  INTO v_draft
  FROM admin.config_drafts AS config_draft
  WHERE config_draft.id = p_draft_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'config draft not found: %', p_draft_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.status <> 'draft' THEN
    RAISE EXCEPTION 'config draft has already been published: %', p_draft_id
      USING ERRCODE = '55000';
  END IF;

  IF v_draft.environment <> v_environment THEN
    RAISE EXCEPTION 'draft environment % does not match configured database environment %',
      v_draft.environment, v_environment
      USING ERRCODE = '42501';
  END IF;

  IF admin.is_managed_config_key(v_draft.config_key) IS NOT TRUE THEN
    RAISE EXCEPTION 'config draft contains an invalid environment or config key'
      USING ERRCODE = '22023';
  END IF;

  IF (v_environment = 'test' AND NOT v_actor.can_access_test)
     OR (v_environment = 'production' AND NOT v_actor.can_access_prod) THEN
    RAISE EXCEPTION 'admin is not permitted to access configured environment: %', v_environment
      USING ERRCODE = '42501';
  END IF;

  PERFORM admin.validate_managed_config_value(
    v_draft.config_key,
    v_draft.value,
    v_draft.text_value
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended('admin.runtime_config:' || v_draft.config_key, 0)
  );

  SELECT to_jsonb(rc)
  INTO v_before
  FROM app_core.runtime_config AS rc
  WHERE rc.key = v_draft.config_key
  FOR UPDATE;

  INSERT INTO app_core.runtime_config AS rc (
    key,
    value,
    description,
    version,
    updated_at,
    text_value
  ) VALUES (
    v_draft.config_key,
    v_draft.value,
    v_draft.description,
    1,
    now(),
    v_draft.text_value
  )
  ON CONFLICT (key) DO UPDATE SET
    value = EXCLUDED.value,
    description = EXCLUDED.description,
    version = COALESCE(rc.version, 0) + 1,
    updated_at = now(),
    text_value = EXCLUDED.text_value
  WHERE COALESCE(rc.version, 0) = v_draft.base_version
  RETURNING * INTO v_runtime;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'config changed after draft creation; save a new draft'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO admin.config_releases (
    environment,
    config_key,
    runtime_version,
    value,
    text_value,
    description,
    source_draft_id,
    released_by
  ) VALUES (
    v_environment,
    v_draft.config_key,
    v_runtime.version,
    v_runtime.value,
    v_runtime.text_value,
    v_runtime.description,
    v_draft.id,
    v_actor.user_id
  )
  RETURNING * INTO v_release;

  UPDATE admin.config_drafts
  SET
    status = 'published',
    updated_by = v_actor.user_id,
    updated_at = now(),
    published_at = now()
  WHERE id = v_draft.id;

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
    v_environment,
    'config.publish',
    'app_core',
    'runtime_config',
    v_draft.config_key,
    v_before,
    to_jsonb(v_runtime) || jsonb_build_object('release_id', v_release.id)
  );

  RETURN v_release;
END;
$function$


-- ==================== admin.reorder_characters(p_character_ids uuid[]) ====================
CREATE OR REPLACE FUNCTION admin.reorder_characters(p_character_ids uuid[])
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_before JSONB;
  v_after JSONB;
  v_expected INTEGER;
BEGIN
  SELECT au.* INTO v_actor
  FROM admin.admin_users AS au
  WHERE au.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_expected
  FROM app_core.characters AS card
  WHERE card.enabled AND card.archived_at IS NULL;

  IF cardinality(p_character_ids) <> v_expected
     OR (
       SELECT count(DISTINCT item.id)
       FROM unnest(p_character_ids) AS item(id)
     ) <> v_expected
     OR EXISTS (
       SELECT 1 FROM unnest(p_character_ids) AS item(id)
       WHERE NOT EXISTS (
         SELECT 1 FROM app_core.characters AS card
         WHERE card.id = item.id AND card.enabled AND card.archived_at IS NULL
       )
     ) THEN
    RAISE EXCEPTION 'reorder must include every enabled active character exactly once'
      USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object('id', card.id, 'sort_order', card.sort_order)
    ORDER BY card.sort_order, card.id
  )
  INTO v_before
  FROM app_core.characters AS card
  WHERE card.enabled AND card.archived_at IS NULL;

  UPDATE app_core.characters AS card
  SET sort_order = ordered.position - 1,
      updated_at = timezone('Asia/Shanghai'::TEXT, now())
  FROM unnest(p_character_ids) WITH ORDINALITY AS ordered(id, position)
  WHERE card.id = ordered.id;

  SELECT jsonb_agg(
    jsonb_build_object('id', card.id, 'sort_order', card.sort_order)
    ORDER BY card.sort_order, card.id
  )
  INTO v_after
  FROM app_core.characters AS card
  WHERE card.enabled AND card.archived_at IS NULL;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    'character.reorder', 'app_core', 'characters', 'enabled',
    v_before, v_after
  );
  RETURN true;
END;
$function$


-- ==================== admin.rollback_character_layout_release(p_release_id uuid, p_expected_layout_version integer) ====================
CREATE OR REPLACE FUNCTION admin.rollback_character_layout_release(p_release_id uuid, p_expected_layout_version integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
  FROM app_core.characters AS card
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
    'app_core', 'characters', p_release_id::TEXT,
    jsonb_build_object(
      'layout_version', v_version,
      'rolled_back_release_id', p_release_id,
      'rolled_back_layout_version', v_target.layout_version,
      'later_characters_preserved_as_delisted', v_missing_ids
    )
  );
  RETURN v_version;
END;
$function$


-- ==================== admin.rollback_config_release(p_release_id uuid) ====================
CREATE OR REPLACE FUNCTION admin.rollback_config_release(p_release_id uuid)
 RETURNS admin.config_releases
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor         admin.admin_users%ROWTYPE;
  v_environment   TEXT;
  v_target        admin.config_releases%ROWTYPE;
  v_runtime       app_core.runtime_config%ROWTYPE;
  v_before        JSONB;
  v_new_release   admin.config_releases%ROWTYPE;
BEGIN
  SELECT au.*
  INTO v_actor
  FROM admin.admin_users AS au
  WHERE au.user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'registered admin required'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor.role NOT IN ('owner', 'operator') THEN
    RAISE EXCEPTION 'viewer accounts are read-only'
      USING ERRCODE = '42501';
  END IF;

  v_environment := admin.current_environment();

  SELECT config_release.*
  INTO v_target
  FROM admin.config_releases AS config_release
  WHERE config_release.id = p_release_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'config release not found: %', p_release_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_target.environment <> v_environment THEN
    RAISE EXCEPTION 'release environment % does not match configured database environment %',
      v_target.environment, v_environment
      USING ERRCODE = '42501';
  END IF;

  IF admin.is_managed_config_key(v_target.config_key) IS NOT TRUE THEN
    RAISE EXCEPTION 'config release contains an invalid environment or config key'
      USING ERRCODE = '22023';
  END IF;

  IF (v_environment = 'test' AND NOT v_actor.can_access_test)
     OR (v_environment = 'production' AND NOT v_actor.can_access_prod) THEN
    RAISE EXCEPTION 'admin is not permitted to access configured environment: %', v_environment
      USING ERRCODE = '42501';
  END IF;

  PERFORM admin.validate_managed_config_value(
    v_target.config_key,
    v_target.value,
    v_target.text_value
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended('admin.runtime_config:' || v_target.config_key, 0)
  );

  SELECT to_jsonb(rc)
  INTO v_before
  FROM app_core.runtime_config AS rc
  WHERE rc.key = v_target.config_key
  FOR UPDATE;

  INSERT INTO app_core.runtime_config AS rc (
    key,
    value,
    description,
    version,
    updated_at,
    text_value
  ) VALUES (
    v_target.config_key,
    v_target.value,
    v_target.description,
    1,
    now(),
    v_target.text_value
  )
  ON CONFLICT (key) DO UPDATE SET
    value = EXCLUDED.value,
    description = EXCLUDED.description,
    version = COALESCE(rc.version, 0) + 1,
    updated_at = now(),
    text_value = EXCLUDED.text_value
  RETURNING * INTO v_runtime;

  INSERT INTO admin.config_releases (
    environment,
    config_key,
    runtime_version,
    value,
    text_value,
    description,
    rollback_of_release_id,
    released_by
  ) VALUES (
    v_environment,
    v_target.config_key,
    v_runtime.version,
    v_runtime.value,
    v_runtime.text_value,
    v_runtime.description,
    v_target.id,
    v_actor.user_id
  )
  RETURNING * INTO v_new_release;

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
    v_environment,
    'config.rollback',
    'app_core',
    'runtime_config',
    v_target.config_key,
    v_before,
    to_jsonb(v_runtime) || jsonb_build_object(
      'release_id', v_new_release.id,
      'rollback_of_release_id', v_target.id
    )
  );

  RETURN v_new_release;
END;
$function$


-- ==================== admin.save_character_layout_draft(p_listed_ids uuid[], p_delisted_ids uuid[], p_deleted_ids uuid[], p_base_layout_version integer) ====================
CREATE OR REPLACE FUNCTION admin.save_character_layout_draft(p_listed_ids uuid[], p_delisted_ids uuid[], p_deleted_ids uuid[], p_base_layout_version integer)
 RETURNS admin.character_layout_drafts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
$function$


-- ==================== admin.save_config_draft(p_environment text, p_config_key text, p_value jsonb, p_text_value text, p_description text) ====================
CREATE OR REPLACE FUNCTION admin.save_config_draft(p_environment text, p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL::text, p_description text DEFAULT NULL::text)
 RETURNS admin.config_drafts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor         admin.admin_users%ROWTYPE;
  v_environment   TEXT;
  v_base_version  INTEGER;
  v_draft         admin.config_drafts%ROWTYPE;
BEGIN
  IF p_environment IS NULL OR p_environment NOT IN ('test', 'production') THEN
    RAISE EXCEPTION 'invalid environment: %', p_environment
      USING ERRCODE = '22023';
  END IF;

  SELECT au.*
  INTO v_actor
  FROM admin.admin_users AS au
  WHERE au.user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'registered admin required'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor.role NOT IN ('owner', 'operator') THEN
    RAISE EXCEPTION 'viewer accounts are read-only'
      USING ERRCODE = '42501';
  END IF;

  v_environment := admin.current_environment();

  IF p_environment <> v_environment THEN
    RAISE EXCEPTION 'requested environment % does not match configured database environment %',
      p_environment, v_environment
      USING ERRCODE = '42501';
  END IF;

  IF (v_environment = 'test' AND NOT v_actor.can_access_test)
     OR (v_environment = 'production' AND NOT v_actor.can_access_prod) THEN
    RAISE EXCEPTION 'admin is not permitted to access configured environment: %', v_environment
      USING ERRCODE = '42501';
  END IF;

  PERFORM admin.validate_managed_config_value(
    p_config_key,
    p_value,
    p_text_value
  );

  SELECT COALESCE(rc.version, 0)
  INTO v_base_version
  FROM app_core.runtime_config AS rc
  WHERE rc.key = p_config_key;

  v_base_version := COALESCE(v_base_version, 0);

  INSERT INTO admin.config_drafts (
    environment,
    config_key,
    value,
    text_value,
    description,
    base_version,
    created_by,
    updated_by
  ) VALUES (
    v_environment,
    p_config_key,
    p_value,
    p_text_value,
    p_description,
    v_base_version,
    v_actor.user_id,
    v_actor.user_id
  )
  RETURNING * INTO v_draft;

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
    v_environment,
    'config.draft.save',
    'admin',
    'config_drafts',
    v_draft.id::TEXT,
    NULL,
    to_jsonb(v_draft)
  );

  RETURN v_draft;
END;
$function$


-- ==================== admin.set_announcement_published(p_id uuid, p_is_published boolean) ====================
CREATE OR REPLACE FUNCTION admin.set_announcement_published(p_id uuid, p_is_published boolean)
 RETURNS miniapp_features.notifications
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_before miniapp_features.notifications%ROWTYPE;
  v_after miniapp_features.notifications%ROWTYPE;
BEGIN
  SELECT actor.* INTO v_actor FROM admin.admin_users AS actor WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  SELECT notification.* INTO v_before
  FROM miniapp_features.notifications AS notification
  WHERE notification.id = p_id AND notification.scope = 'official'
    AND notification.user_id IS NULL
    AND notification.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'announcement not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE miniapp_features.notifications
  SET is_published = COALESCE(p_is_published, false),
      published_at = CASE
        WHEN COALESCE(p_is_published, false) THEN COALESCE(published_at, now())
        ELSE NULL
      END,
      updated_at = now()
  WHERE id = p_id
  RETURNING * INTO v_after;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name, table_name,
    record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    CASE WHEN v_after.is_published THEN 'announcement.publish' ELSE 'announcement.unpublish' END,
    'miniapp_features', 'notifications', p_id::TEXT, to_jsonb(v_before), to_jsonb(v_after)
  );
  RETURN v_after;
END;
$function$


-- ==================== admin.set_character_enabled(p_character_id uuid, p_enabled boolean) ====================
CREATE OR REPLACE FUNCTION admin.set_character_enabled(p_character_id uuid, p_enabled boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_before app_core.characters%ROWTYPE;
  v_after app_core.characters%ROWTYPE;
  v_next_order INTEGER;
BEGIN
  SELECT au.* INTO v_actor
  FROM admin.admin_users AS au
  WHERE au.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  SELECT card.* INTO v_before
  FROM app_core.characters AS card
  WHERE card.id = p_character_id AND card.archived_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active character not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_enabled AND NOT v_before.enabled THEN
    SELECT COALESCE(max(card.sort_order), -1) + 1 INTO v_next_order
    FROM app_core.characters AS card
    WHERE card.enabled AND card.archived_at IS NULL;
  ELSE
    v_next_order := v_before.sort_order;
  END IF;

  UPDATE app_core.characters
  SET enabled = p_enabled,
      sort_order = v_next_order,
      updated_at = timezone('Asia/Shanghai'::TEXT, now())
  WHERE id = p_character_id
  RETURNING * INTO v_after;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    CASE WHEN p_enabled THEN 'character.enable' ELSE 'character.disable' END,
    'app_core', 'characters', p_character_id::TEXT,
    to_jsonb(v_before), to_jsonb(v_after)
  );
  RETURN true;
END;
$function$


-- ==================== admin.set_operator_name(p_display_name text) ====================
CREATE OR REPLACE FUNCTION admin.set_operator_name(p_display_name text)
 RETURNS admin.admin_users
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_name  TEXT;
  v_actor admin.admin_users%ROWTYPE;
BEGIN
  v_name := trim(COALESCE(p_display_name, ''));
  IF char_length(v_name) = 0 OR char_length(v_name) > 80 THEN
    RAISE EXCEPTION 'operator name must contain 1 to 80 characters'
      USING ERRCODE = '22023';
  END IF;

  UPDATE admin.admin_users
  SET display_name = v_name, updated_at = now()
  WHERE user_id = auth.uid()
  RETURNING * INTO v_actor;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'registered admin required'
      USING ERRCODE = '42501';
  END IF;

  RETURN v_actor;
END;
$function$


-- ==================== admin.snapshot_operator_name() ====================
CREATE OR REPLACE FUNCTION admin.snapshot_operator_name()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_name TEXT;
BEGIN
  IF TG_TABLE_NAME = 'audit_logs' THEN
    SELECT au.display_name
    INTO v_name
    FROM admin.admin_users AS au
    WHERE au.user_id = NEW.actor_user_id;

    IF COALESCE(char_length(trim(v_name)), 0) = 0 THEN
      RAISE EXCEPTION 'operator name is required; sign in again'
        USING ERRCODE = '42501';
    END IF;

    NEW.actor_name := v_name;
  ELSIF TG_TABLE_NAME = 'config_releases' THEN
    SELECT au.display_name
    INTO v_name
    FROM admin.admin_users AS au
    WHERE au.user_id = NEW.released_by;

    IF COALESCE(char_length(trim(v_name)), 0) = 0 THEN
      RAISE EXCEPTION 'operator name is required; sign in again'
        USING ERRCODE = '42501';
    END IF;

    NEW.released_by_name := v_name;
  END IF;

  RETURN NEW;
END;
$function$


-- ==================== admin.update_announcement(p_id uuid, p_category text, p_title text, p_body text, p_sort_order integer) ====================
CREATE OR REPLACE FUNCTION admin.update_announcement(p_id uuid, p_category text, p_title text, p_body text, p_sort_order integer)
 RETURNS miniapp_features.notifications
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_before miniapp_features.notifications%ROWTYPE;
  v_after miniapp_features.notifications%ROWTYPE;
BEGIN
  SELECT actor.* INTO v_actor FROM admin.admin_users AS actor WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  SELECT notification.* INTO v_before
  FROM miniapp_features.notifications AS notification
  WHERE notification.id = p_id AND notification.scope = 'official'
    AND notification.user_id IS NULL
    AND notification.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'announcement not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE miniapp_features.notifications
  SET category = p_category, title = trim(p_title), body = trim(p_body),
      sort_order = p_sort_order, updated_at = now()
  WHERE id = p_id
  RETURNING * INTO v_after;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name, table_name,
    record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    'announcement.update', 'miniapp_features', 'notifications', p_id::TEXT,
    to_jsonb(v_before), to_jsonb(v_after)
  );
  RETURN v_after;
END;
$function$


-- ==================== admin.upsert_config_draft(p_environment text, p_config_key text, p_value jsonb, p_text_value text, p_description text) ====================
CREATE OR REPLACE FUNCTION admin.upsert_config_draft(p_environment text, p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL::text, p_description text DEFAULT NULL::text)
 RETURNS admin.config_drafts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor   admin.admin_users%ROWTYPE;
  v_before  JSONB;
  v_draft   admin.config_drafts%ROWTYPE;
BEGIN
  SELECT au.* INTO v_actor
  FROM admin.admin_users AS au
  WHERE au.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator') THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  IF p_environment <> admin.current_environment()
     OR (p_environment = 'test' AND NOT v_actor.can_access_test)
     OR (p_environment = 'production' AND NOT v_actor.can_access_prod) THEN
    RAISE EXCEPTION 'admin is not permitted to access requested environment'
      USING ERRCODE = '42501';
  END IF;

  PERFORM admin.validate_managed_config_value(p_config_key, p_value, p_text_value);

  SELECT draft.*
  INTO v_draft
  FROM admin.config_drafts AS draft
  WHERE draft.environment = p_environment
    AND draft.config_key = p_config_key
    AND draft.status = 'draft'
  FOR UPDATE;

  IF FOUND THEN
    v_before := to_jsonb(v_draft);
    UPDATE admin.config_drafts
    SET value = p_value,
        text_value = p_text_value,
        description = p_description,
        updated_by = v_actor.user_id,
        updated_at = now()
    WHERE id = v_draft.id
    RETURNING * INTO v_draft;

    INSERT INTO admin.audit_logs (
      actor_user_id, actor_email, environment, action, schema_name,
      table_name, record_id, before_value, after_value
    ) VALUES (
      v_actor.user_id, v_actor.email, p_environment, 'config.draft.autosave',
      'admin', 'config_drafts', v_draft.id::TEXT, v_before, to_jsonb(v_draft)
    );
    RETURN v_draft;
  END IF;

  RETURN admin.save_config_draft(
    p_environment,
    p_config_key,
    p_value,
    p_text_value,
    p_description
  );
END;
$function$


-- ==================== admin.validate_character_layout(p_listed_ids uuid[], p_delisted_ids uuid[], p_deleted_ids uuid[]) ====================
CREATE OR REPLACE FUNCTION admin.validate_character_layout(p_listed_ids uuid[], p_delisted_ids uuid[], p_deleted_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_all UUID[] := COALESCE(p_listed_ids, '{}') || COALESCE(p_delisted_ids, '{}') ||
                  COALESCE(p_deleted_ids, '{}');
  v_character_count INTEGER;
  v_unique_count INTEGER;
  v_test_names TEXT;
BEGIN
  SELECT string_agg(card.name, '、' ORDER BY card.name) INTO v_test_names
  FROM app_core.characters AS card
  WHERE card.is_test
    AND EXISTS (SELECT 1 FROM unnest(v_all) AS item(id) WHERE item.id = card.id);

  IF v_test_names IS NOT NULL THEN
    RAISE EXCEPTION 'character layout must not contain evaluation test cards: %', v_test_names
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_character_count
  FROM app_core.characters AS card
  WHERE NOT card.is_test;
  SELECT count(DISTINCT item.id) INTO v_unique_count FROM unnest(v_all) AS item(id);

  IF cardinality(v_all) <> v_character_count OR v_unique_count <> v_character_count
     OR EXISTS (
       SELECT 1 FROM unnest(v_all) AS item(id)
       WHERE NOT EXISTS (SELECT 1 FROM app_core.characters AS card WHERE card.id = item.id)
     ) THEN
    RAISE EXCEPTION 'character layout must partition every character exactly once'
      USING ERRCODE = '22023';
  END IF;
END;
$function$


-- ==================== admin.validate_fixed_llm_deduction_config(p_value jsonb) ====================
CREATE OR REPLACE FUNCTION admin.validate_fixed_llm_deduction_config(p_value jsonb)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF p_value IS NULL
     OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_value -> 'fixedDeduction') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_value -> 'fixedDeduction' -> 'freeQuotaExhausted')
        IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_value -> 'fixedDeduction' -> 'light') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_value -> 'fixedDeduction' -> 'standard') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_value -> 'fixedDeduction' -> 'premium') IS DISTINCT FROM 'number'
     OR (p_value #>> '{fixedDeduction,freeQuotaExhausted}')::NUMERIC < 0
     OR (p_value #>> '{fixedDeduction,light}')::NUMERIC < 0
     OR (p_value #>> '{fixedDeduction,standard}')::NUMERIC < 0
     OR (p_value #>> '{fixedDeduction,premium}')::NUMERIC < 0 THEN
    RAISE EXCEPTION
      'llm_pricing_config.fixedDeduction must include nonnegative freeQuotaExhausted, light, standard and premium amounts'
      USING ERRCODE = '22023';
  END IF;
END;
$function$


-- ==================== admin.validate_free_quota_exhausted_dialog_config(p_value jsonb) ====================
CREATE OR REPLACE FUNCTION admin.validate_free_quota_exhausted_dialog_config(p_value jsonb)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF p_value IS NULL
     OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
     OR COALESCE(char_length(trim(p_value ->> 'text')), 0) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'miniapp_free_quota_exhausted_dialog_config is invalid'
      USING ERRCODE = '22023';
  END IF;
END;
$function$


-- ==================== admin.validate_lobby_pinned_characters(p_value jsonb) ====================
CREATE OR REPLACE FUNCTION admin.validate_lobby_pinned_characters(p_value jsonb)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_max_pinned CONSTANT INT := 8;
  v_ids TEXT[] := ARRAY[]::TEXT[];
  v_item JSONB;
  v_id TEXT;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'lobby_pinned_characters must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_value -> 'character_ids') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'lobby_pinned_characters.character_ids must be an array'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_value -> 'character_ids') > v_max_pinned THEN
    RAISE EXCEPTION 'lobby_pinned_characters.character_ids must not exceed % entries', v_max_pinned
      USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_value -> 'character_ids')
  LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'lobby_pinned_characters.character_ids must contain only strings'
        USING ERRCODE = '22023';
    END IF;

    v_id := trim(v_item #>> '{}');

    IF v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'lobby_pinned_characters.character_ids must contain character UUIDs, got %', v_id
        USING ERRCODE = '22023';
    END IF;

    IF v_id = ANY (v_ids) THEN
      RAISE EXCEPTION 'lobby_pinned_characters.character_ids must be unique, % appears twice', v_id
        USING ERRCODE = '22023';
    END IF;
    v_ids := array_append(v_ids, v_id);
  END LOOP;
END;
$function$


-- ==================== admin.validate_lobby_ranking_params(p_value jsonb) ====================
CREATE OR REPLACE FUNCTION admin.validate_lobby_ranking_params(p_value jsonb)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  -- 字段名 → [下界, 上界, 是否必须为整数(1/0)]
  v_specs JSONB := jsonb_build_array(
    jsonb_build_array('window_days', 1, 365, 1),
    jsonb_build_array('turn_cap', 1, 1000, 1),
    jsonb_build_array('session_gap_minutes', 1, 1440, 1),
    jsonb_build_array('return_window_hours', 1, 720, 1),
    jsonb_build_array('d30_weight', 0, 1, 0),
    jsonb_build_array('r48_weight', 0, 1, 0),
    jsonb_build_array('d30_prior_weight', 0, 100000, 0),
    jsonb_build_array('min_users', 1, 1000000, 1),
    jsonb_build_array('r48_full_trust_sample', 1, 1000000, 1),
    jsonb_build_array('neutral_norm', 0, 1, 0),
    jsonb_build_array('norm_percentile_low', 0, 1, 0),
    jsonb_build_array('norm_percentile_high', 0, 1, 0)
  );
  v_spec JSONB;
  v_name TEXT;
  v_num NUMERIC;
  v_lookback NUMERIC;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'lobby_ranking_params must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  FOR v_spec IN SELECT value FROM jsonb_array_elements(v_specs)
  LOOP
    v_name := v_spec ->> 0;

    IF jsonb_typeof(p_value -> v_name) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'lobby_ranking_params.% must be a number', v_name
        USING ERRCODE = '22023';
    END IF;

    v_num := (p_value ->> v_name)::NUMERIC;

    IF v_num < (v_spec ->> 1)::NUMERIC OR v_num > (v_spec ->> 2)::NUMERIC THEN
      RAISE EXCEPTION 'lobby_ranking_params.% must be between % and %',
        v_name, v_spec ->> 1, v_spec ->> 2
        USING ERRCODE = '22023';
    END IF;

    IF (v_spec ->> 3)::INT = 1 AND v_num <> trunc(v_num) THEN
      RAISE EXCEPTION 'lobby_ranking_params.% must be an integer', v_name
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- null 是有效取值，表示「回看全历史」，所以单独校验而不进上面的循环。
  IF NOT p_value ? 'first_touch_lookback_days' THEN
    RAISE EXCEPTION 'lobby_ranking_params.first_touch_lookback_days is required (use null for unlimited)'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_value -> 'first_touch_lookback_days') NOT IN ('number', 'null') THEN
    RAISE EXCEPTION 'lobby_ranking_params.first_touch_lookback_days must be a number or null'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_value -> 'first_touch_lookback_days') = 'number' THEN
    v_lookback := (p_value ->> 'first_touch_lookback_days')::NUMERIC;
    IF v_lookback < 1 OR v_lookback > 3650 OR v_lookback <> trunc(v_lookback) THEN
      RAISE EXCEPTION 'lobby_ranking_params.first_touch_lookback_days must be an integer between 1 and 3650'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 权重和不为 1 时分数不再落在 0–100，会推翻「score 是百分制」这个既有口径，
  -- 而运营对分数的直觉、以及所有历史分数的可比性都建立在它上面。
  IF abs(
       (p_value ->> 'd30_weight')::NUMERIC + (p_value ->> 'r48_weight')::NUMERIC - 1
     ) > 0.000001 THEN
    RAISE EXCEPTION 'lobby_ranking_params d30_weight + r48_weight must equal 1'
      USING ERRCODE = '22023';
  END IF;

  -- 低位 >= 高位时归一化区间宽度为 0 或负，所有卡会被推到极端值。
  IF (p_value ->> 'norm_percentile_low')::NUMERIC
     >= (p_value ->> 'norm_percentile_high')::NUMERIC THEN
    RAISE EXCEPTION 'lobby_ranking_params norm_percentile_low must be less than norm_percentile_high'
      USING ERRCODE = '22023';
  END IF;
END;
$function$


-- ==================== admin.validate_managed_config_value(p_config_key text, p_value jsonb, p_text_value text) ====================
CREATE OR REPLACE FUNCTION admin.validate_managed_config_value(p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_tier JSONB;
  v_ids TEXT[];
  v_default TEXT;
  v_columns NUMERIC;
  v_enabled_default BOOLEAN := FALSE;
BEGIN
  IF p_config_key IN ('voice_billing_enabled', 'voice_generation_credits',
                     'voice_max_spoken_chars', 'voice_price_label',
                     'voice_over_limit_hint', 'voice_draft_failed_hint',
                     'voice_tts_failed_hint') THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION '% must not use text_value', p_config_key
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_voice_config_value(p_config_key, p_value);
    RETURN;
  END IF;

  IF p_config_key = 'miniapp_payment_prompt_dialog_config' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_payment_prompt_dialog_config must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_payment_prompt_dialog_config(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'system_instructions' THEN
    IF p_value IS NOT NULL THEN
      RAISE EXCEPTION 'system_instructions must store markdown in text_value (value must be null)'
        USING ERRCODE = '22023';
    END IF;
    IF p_text_value IS NULL OR char_length(trim(p_text_value)) = 0 THEN
      RAISE EXCEPTION 'system_instructions text_value must be a nonempty markdown string'
        USING ERRCODE = '22023';
    END IF;
    IF position('{{WORD_COUNT}}' IN p_text_value) = 0
       OR position('{{INTERACTION_MODE}}' IN p_text_value) = 0
       OR position('{{USER_CUSTOM_INSTRUCTIONS}}' IN p_text_value) = 0 THEN
      RAISE EXCEPTION
        'system_instructions must contain {{WORD_COUNT}}, {{INTERACTION_MODE}} and {{USER_CUSTOM_INSTRUCTIONS}}'
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key = 'lobby_pinned_characters' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'lobby_pinned_characters must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_lobby_pinned_characters(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'lobby_ranking_params' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'lobby_ranking_params must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_lobby_ranking_params(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'pref_word_count_tiers' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'pref_word_count_tiers must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    IF p_value IS NULL
       OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
       OR jsonb_typeof(p_value -> 'tiers') IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_value -> 'tiers') = 0
       OR jsonb_typeof(p_value -> 'default_tier_id') IS DISTINCT FROM 'string'
       OR COALESCE(char_length(trim(p_value ->> 'default_tier_id')), 0) = 0 THEN
      RAISE EXCEPTION
        'pref_word_count_tiers must include nonempty tiers and default_tier_id'
        USING ERRCODE = '22023';
    END IF;

    v_columns := NULLIF(p_value #>> '{layout,columns}', '')::NUMERIC;
    IF v_columns IS NULL OR v_columns NOT IN (2, 3, 4) THEN
      RAISE EXCEPTION 'pref_word_count_tiers.layout.columns must be 2, 3 or 4'
        USING ERRCODE = '22023';
    END IF;

    v_ids := ARRAY[]::TEXT[];
    v_default := trim(p_value ->> 'default_tier_id');
    FOR v_tier IN SELECT value FROM jsonb_array_elements(p_value -> 'tiers')
    LOOP
      IF jsonb_typeof(v_tier) IS DISTINCT FROM 'object'
         OR COALESCE(char_length(trim(v_tier ->> 'id')), 0) = 0
         OR COALESCE(char_length(trim(v_tier ->> 'ui_label')), 0) = 0
         OR COALESCE(char_length(trim(v_tier ->> 'prompt_value')), 0) = 0
         OR jsonb_typeof(v_tier -> 'enabled') IS DISTINCT FROM 'boolean'
         OR jsonb_typeof(v_tier -> 'sort_order') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'pref_word_count_tiers contains an invalid tier'
          USING ERRCODE = '22023';
      END IF;

      IF trim(v_tier ->> 'id') = ANY (v_ids) THEN
        RAISE EXCEPTION 'pref_word_count_tiers tier ids must be unique'
          USING ERRCODE = '22023';
      END IF;
      v_ids := array_append(v_ids, trim(v_tier ->> 'id'));

      IF trim(v_tier ->> 'id') = v_default AND (v_tier ->> 'enabled')::BOOLEAN IS TRUE THEN
        v_enabled_default := TRUE;
      END IF;
    END LOOP;

    IF NOT v_enabled_default THEN
      RAISE EXCEPTION 'pref_word_count_tiers.default_tier_id must match an enabled tier'
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key = 'miniapp_character_free_chat_quota_limit' THEN
    IF p_value IS NULL
       OR jsonb_typeof(p_value) IS DISTINCT FROM 'number'
       OR (p_value #>> '{}')::NUMERIC <> trunc((p_value #>> '{}')::NUMERIC)
       OR (p_value #>> '{}')::NUMERIC < 1 THEN
      RAISE EXCEPTION
        'miniapp_character_free_chat_quota_limit must be a positive JSON integer'
        USING ERRCODE = '22023';
    END IF;
    PERFORM p_text_value;
    RETURN;
  END IF;

  IF p_config_key = 'llm_model_catalog' THEN
    PERFORM admin.validate_model_catalog_core(p_value);
    PERFORM admin.validate_model_catalog_prd(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'llm_pricing_config' THEN
    PERFORM admin.validate_fixed_llm_deduction_config(p_value);
    RETURN;
  END IF;

  PERFORM admin.validate_managed_config_value_before_fixed_billing(
    p_config_key,
    p_value,
    p_text_value
  );
END;
$function$


-- ==================== admin.validate_managed_config_value_before_fixed_billing(p_config_key text, p_value jsonb, p_text_value text) ====================
CREATE OR REPLACE FUNCTION admin.validate_managed_config_value_before_fixed_billing(p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_uuid UUID;
BEGIN
  IF admin.is_managed_config_key(p_config_key) IS NOT TRUE THEN
    RAISE EXCEPTION 'config key is not managed by admin: %', p_config_key
      USING ERRCODE = '22023';
  END IF;

  CASE
    WHEN p_config_key IN (
      'miniapp_new_user_signup_bonus_credits',
      'miniapp_daily_checkin_bonus_credits'
    ) THEN
      IF p_value IS NULL
         OR jsonb_typeof(p_value) IS DISTINCT FROM 'number'
         OR (p_value #>> '{}')::NUMERIC < 0 THEN
        RAISE EXCEPTION '% must be a nonnegative JSON number', p_config_key
          USING ERRCODE = '22023';
      END IF;

    WHEN p_config_key = 'miniapp_payment_plans' THEN
      IF p_value IS NULL
         OR jsonb_typeof(p_value) IS DISTINCT FROM 'array'
         OR jsonb_array_length(p_value) = 0 THEN
        RAISE EXCEPTION 'miniapp_payment_plans must be a nonempty JSON array'
          USING ERRCODE = '22023';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_value) AS plan
        WHERE jsonb_typeof(plan) IS DISTINCT FROM 'object'
          OR COALESCE(char_length(trim(plan ->> 'id')), 0) = 0
          OR jsonb_typeof(plan -> 'price_cents') IS DISTINCT FROM 'number'
          OR jsonb_typeof(plan -> 'credits_amount') IS DISTINCT FROM 'number'
          OR jsonb_typeof(plan -> 'bonus_credits') IS DISTINCT FROM 'number'
          OR CASE
               WHEN jsonb_typeof(plan -> 'price_cents') = 'number'
               THEN (plan ->> 'price_cents')::NUMERIC < 0
               ELSE true
             END
          OR CASE
               WHEN jsonb_typeof(plan -> 'credits_amount') = 'number'
               THEN (plan ->> 'credits_amount')::NUMERIC < 0
               ELSE true
             END
          OR CASE
               WHEN jsonb_typeof(plan -> 'bonus_credits') = 'number'
               THEN (plan ->> 'bonus_credits')::NUMERIC < 0
               ELSE true
             END
          OR COALESCE(plan ->> 'variant', '') NOT IN (
            'entry', 'standard', 'recommended', 'premium'
          )
      ) THEN
        RAISE EXCEPTION 'miniapp_payment_plans contains an invalid plan'
          USING ERRCODE = '22023';
      END IF;

    WHEN p_config_key = 'miniapp_recharge_page_config' THEN
      PERFORM admin.validate_recharge_page_config(p_value);

    WHEN p_config_key = 'miniapp_free_quota_exhausted_dialog_config' THEN
      PERFORM admin.validate_free_quota_exhausted_dialog_config(p_value);

    WHEN p_config_key = 'llm_model_catalog' THEN
      IF p_value IS NULL
         OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
         OR jsonb_typeof(p_value -> 'tiers') IS DISTINCT FROM 'array'
         OR jsonb_array_length(p_value -> 'tiers') = 0
         OR jsonb_typeof(p_value -> 'default_model_id') IS DISTINCT FROM 'string'
         OR COALESCE(char_length(trim(p_value ->> 'default_model_id')), 0) = 0 THEN
        RAISE EXCEPTION 'llm_model_catalog must include nonempty tiers and default_model_id'
          USING ERRCODE = '22023';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_value -> 'tiers') AS tier
        WHERE jsonb_typeof(tier) IS DISTINCT FROM 'object'
          OR COALESCE(tier ->> 'tier', '') NOT IN ('light', 'standard', 'premium')
          OR COALESCE(char_length(trim(tier ->> 'label')), 0) = 0
          OR COALESCE(char_length(trim(tier ->> 'color')), 0) = 0
          OR jsonb_typeof(tier -> 'sort_order') IS DISTINCT FROM 'number'
          OR jsonb_typeof(tier -> 'models') IS DISTINCT FROM 'array'
      ) THEN
        RAISE EXCEPTION 'llm_model_catalog contains an invalid tier'
          USING ERRCODE = '22023';
      END IF;

      IF (
        SELECT count(*) <> count(DISTINCT tier ->> 'tier')
        FROM jsonb_array_elements(p_value -> 'tiers') AS tier
      ) THEN
        RAISE EXCEPTION 'llm_model_catalog tier keys must be unique'
          USING ERRCODE = '22023';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_value -> 'tiers') AS tier
        CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
        WHERE jsonb_typeof(model) IS DISTINCT FROM 'object'
          OR COALESCE(char_length(trim(model ->> 'id')), 0) = 0
          OR COALESCE(char_length(trim(model ->> 'openrouter_model_id')), 0) = 0
          OR COALESCE(char_length(trim(model ->> 'display_name')), 0) = 0
          OR char_length(COALESCE(model ->> 'tagline', '')) > 15
          OR jsonb_typeof(model -> 'price_input') IS DISTINCT FROM 'number'
          OR jsonb_typeof(model -> 'price_output') IS DISTINCT FROM 'number'
          OR jsonb_typeof(model -> 'enabled') IS DISTINCT FROM 'boolean'
          OR jsonb_typeof(model -> 'sort_order') IS DISTINCT FROM 'number'
          OR CASE
               WHEN jsonb_typeof(model -> 'price_input') = 'number'
               THEN (model ->> 'price_input')::NUMERIC < 0
               ELSE true
             END
          OR CASE
               WHEN jsonb_typeof(model -> 'price_output') = 'number'
               THEN (model ->> 'price_output')::NUMERIC < 0
               ELSE true
             END
      ) THEN
        RAISE EXCEPTION 'llm_model_catalog contains an invalid model'
          USING ERRCODE = '22023';
      END IF;

      IF (
        SELECT count(*) <> count(DISTINCT model ->> 'id')
        FROM jsonb_array_elements(p_value -> 'tiers') AS tier
        CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
      ) THEN
        RAISE EXCEPTION 'llm_model_catalog model ids must be unique'
          USING ERRCODE = '22023';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_value -> 'tiers') AS tier
        CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
        WHERE model ->> 'id' = p_value ->> 'default_model_id'
          AND model -> 'enabled' = 'true'::JSONB
      ) THEN
        RAISE EXCEPTION 'llm_model_catalog default_model_id must identify an enabled model'
          USING ERRCODE = '22023';
      END IF;

    WHEN p_config_key = 'llm_pricing_config' THEN
      IF p_value IS NULL
         OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
         OR jsonb_typeof(p_value -> 'balanceBaseline') IS DISTINCT FROM 'number'
         OR jsonb_typeof(p_value -> 'fallbackCost') IS DISTINCT FROM 'number'
         OR jsonb_typeof(p_value -> 'exchangeRate') IS DISTINCT FROM 'number'
         OR jsonb_typeof(p_value -> 'markup') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'llm_pricing_config must include four numeric fields'
          USING ERRCODE = '22023';
      END IF;

      IF (p_value ->> 'balanceBaseline')::NUMERIC < 0
         OR (p_value ->> 'fallbackCost')::NUMERIC < 0
         OR (p_value ->> 'exchangeRate')::NUMERIC <= 0
         OR (p_value ->> 'markup')::NUMERIC <= 0 THEN
        RAISE EXCEPTION 'llm_pricing_config values are outside the allowed range'
          USING ERRCODE = '22023';
      END IF;

    WHEN p_config_key = 'system_fallback_character_id' THEN
      IF p_value IS NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'system_fallback_character_id must be a UUID JSON string'
          USING ERRCODE = '22023';
      END IF;

      BEGIN
        v_uuid := (p_value #>> '{}')::UUID;
      EXCEPTION
        WHEN invalid_text_representation THEN
          RAISE EXCEPTION 'system_fallback_character_id must be a UUID JSON string'
            USING ERRCODE = '22023';
      END;

    ELSE
      RAISE EXCEPTION 'managed config validation is missing for key: %', p_config_key
        USING ERRCODE = '22023';
  END CASE;

  PERFORM p_text_value;
END;
$function$


-- ==================== admin.validate_managed_config_value_before_payment_prompt(p_config_key text, p_value jsonb, p_text_value text) ====================
CREATE OR REPLACE FUNCTION admin.validate_managed_config_value_before_payment_prompt(p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_tier JSONB;
  v_ids TEXT[];
  v_default TEXT;
  v_columns NUMERIC;
  v_enabled_default BOOLEAN := FALSE;
BEGIN
  IF p_config_key = 'system_instructions' THEN
    IF p_value IS NOT NULL THEN
      RAISE EXCEPTION 'system_instructions must store markdown in text_value (value must be null)'
        USING ERRCODE = '22023';
    END IF;
    IF p_text_value IS NULL OR char_length(trim(p_text_value)) = 0 THEN
      RAISE EXCEPTION 'system_instructions text_value must be a nonempty markdown string'
        USING ERRCODE = '22023';
    END IF;
    IF position('{{WORD_COUNT}}' IN p_text_value) = 0
       OR position('{{INTERACTION_MODE}}' IN p_text_value) = 0
       OR position('{{USER_CUSTOM_INSTRUCTIONS}}' IN p_text_value) = 0 THEN
      RAISE EXCEPTION
        'system_instructions must contain {{WORD_COUNT}}, {{INTERACTION_MODE}} and {{USER_CUSTOM_INSTRUCTIONS}}'
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key = 'lobby_pinned_characters' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'lobby_pinned_characters must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_lobby_pinned_characters(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'lobby_ranking_params' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'lobby_ranking_params must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_lobby_ranking_params(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'pref_word_count_tiers' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'pref_word_count_tiers must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    IF p_value IS NULL
       OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
       OR jsonb_typeof(p_value -> 'tiers') IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_value -> 'tiers') = 0
       OR jsonb_typeof(p_value -> 'default_tier_id') IS DISTINCT FROM 'string'
       OR COALESCE(char_length(trim(p_value ->> 'default_tier_id')), 0) = 0 THEN
      RAISE EXCEPTION
        'pref_word_count_tiers must include nonempty tiers and default_tier_id'
        USING ERRCODE = '22023';
    END IF;

    v_columns := NULLIF(p_value #>> '{layout,columns}', '')::NUMERIC;
    IF v_columns IS NULL OR v_columns NOT IN (2, 3, 4) THEN
      RAISE EXCEPTION 'pref_word_count_tiers.layout.columns must be 2, 3 or 4'
        USING ERRCODE = '22023';
    END IF;

    v_ids := ARRAY[]::TEXT[];
    v_default := trim(p_value ->> 'default_tier_id');
    FOR v_tier IN SELECT value FROM jsonb_array_elements(p_value -> 'tiers')
    LOOP
      IF jsonb_typeof(v_tier) IS DISTINCT FROM 'object'
         OR COALESCE(char_length(trim(v_tier ->> 'id')), 0) = 0
         OR COALESCE(char_length(trim(v_tier ->> 'ui_label')), 0) = 0
         OR COALESCE(char_length(trim(v_tier ->> 'prompt_value')), 0) = 0
         OR jsonb_typeof(v_tier -> 'enabled') IS DISTINCT FROM 'boolean'
         OR jsonb_typeof(v_tier -> 'sort_order') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'pref_word_count_tiers contains an invalid tier'
          USING ERRCODE = '22023';
      END IF;

      IF trim(v_tier ->> 'id') = ANY (v_ids) THEN
        RAISE EXCEPTION 'pref_word_count_tiers tier ids must be unique'
          USING ERRCODE = '22023';
      END IF;
      v_ids := array_append(v_ids, trim(v_tier ->> 'id'));

      IF trim(v_tier ->> 'id') = v_default AND (v_tier ->> 'enabled')::BOOLEAN IS TRUE THEN
        v_enabled_default := TRUE;
      END IF;
    END LOOP;

    IF NOT v_enabled_default THEN
      RAISE EXCEPTION 'pref_word_count_tiers.default_tier_id must match an enabled tier'
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key = 'miniapp_character_free_chat_quota_limit' THEN
    IF p_value IS NULL
       OR jsonb_typeof(p_value) IS DISTINCT FROM 'number'
       OR (p_value #>> '{}')::NUMERIC <> trunc((p_value #>> '{}')::NUMERIC)
       OR (p_value #>> '{}')::NUMERIC < 1 THEN
      RAISE EXCEPTION
        'miniapp_character_free_chat_quota_limit must be a positive JSON integer'
        USING ERRCODE = '22023';
    END IF;
    PERFORM p_text_value;
    RETURN;
  END IF;

  IF p_config_key = 'llm_model_catalog' THEN
    PERFORM admin.validate_model_catalog_core(p_value);
    PERFORM admin.validate_model_catalog_prd(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'llm_pricing_config' THEN
    PERFORM admin.validate_fixed_llm_deduction_config(p_value);
    RETURN;
  END IF;

  PERFORM admin.validate_managed_config_value_before_fixed_billing(
    p_config_key,
    p_value,
    p_text_value
  );
END;
$function$


-- ==================== admin.validate_model_catalog_core(p_value jsonb) ====================
CREATE OR REPLACE FUNCTION admin.validate_model_catalog_core(p_value jsonb)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF p_value IS NULL
     OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_value -> 'tiers') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_value -> 'tiers') = 0
     OR jsonb_typeof(p_value -> 'default_model_id') IS DISTINCT FROM 'string'
     OR COALESCE(char_length(trim(p_value ->> 'default_model_id')), 0) = 0 THEN
    RAISE EXCEPTION 'llm_model_catalog must include nonempty tiers and default_model_id'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    WHERE jsonb_typeof(tier) IS DISTINCT FROM 'object'
      OR COALESCE(tier ->> 'tier', '') NOT IN ('light', 'standard', 'premium')
      OR COALESCE(char_length(trim(tier ->> 'label')), 0) = 0
      OR COALESCE(char_length(trim(tier ->> 'color')), 0) = 0
      OR jsonb_typeof(tier -> 'sort_order') IS DISTINCT FROM 'number'
      OR jsonb_typeof(tier -> 'models') IS DISTINCT FROM 'array'
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog contains an invalid tier'
      USING ERRCODE = '22023';
  END IF;

  IF (
    SELECT count(*) <> count(DISTINCT tier ->> 'tier')
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog tier keys must be unique'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
    WHERE jsonb_typeof(model) IS DISTINCT FROM 'object'
      OR COALESCE(char_length(trim(model ->> 'id')), 0) = 0
      OR COALESCE(char_length(trim(model ->> 'openrouter_model_id')), 0) = 0
      OR COALESCE(char_length(trim(model ->> 'display_name')), 0) = 0
      OR COALESCE(char_length(trim(model ->> 'tagline')), 0) = 0
      OR jsonb_typeof(model -> 'enabled') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(model -> 'sort_order') IS DISTINCT FROM 'number'
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog contains an invalid model'
      USING ERRCODE = '22023';
  END IF;

  IF (
    SELECT count(*) <> count(DISTINCT model ->> 'id')
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog model ids must be unique'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
    WHERE model ->> 'id' = p_value ->> 'default_model_id'
      AND model -> 'enabled' = 'true'::JSONB
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog default_model_id must identify an enabled model'
      USING ERRCODE = '22023';
  END IF;
END;
$function$


-- ==================== admin.validate_model_catalog_draft_trigger() ====================
CREATE OR REPLACE FUNCTION admin.validate_model_catalog_draft_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NEW.config_key = 'llm_model_catalog' THEN
    PERFORM admin.validate_model_catalog_prd(NEW.value);
  END IF;
  RETURN NEW;
END;
$function$


-- ==================== admin.validate_model_catalog_prd(p_value jsonb) ====================
CREATE OR REPLACE FUNCTION admin.validate_model_catalog_prd(p_value jsonb)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    WHERE trim(tier ->> 'label') = ''
      OR char_length(trim(tier ->> 'label')) > 20
      OR COALESCE(tier ->> 'color', '') !~ '^#[0-9A-Fa-f]{6}$'
      OR COALESCE(char_length(trim(tier ->> 'cost_hint')), 0) NOT BETWEEN 1 AND 50
      OR jsonb_array_length(tier -> 'models') = 0
      OR (tier ->> 'sort_order')::NUMERIC < 0
      OR (tier ->> 'sort_order')::NUMERIC <> trunc((tier ->> 'sort_order')::NUMERIC)
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog contains invalid PRD tier fields'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
    WHERE COALESCE(model ->> 'id', '') !~ '^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$'
      OR char_length(model ->> 'id') > 64
      OR COALESCE(model ->> 'openrouter_model_id', '') !~ '^[^[:space:]/]+/[^[:space:]/]+$'
      OR char_length(model ->> 'openrouter_model_id') > 200
      OR COALESCE(char_length(trim(model ->> 'display_name')), 0) NOT BETWEEN 1 AND 40
      OR COALESCE(char_length(trim(model ->> 'tagline')), 0) NOT BETWEEN 1 AND 40
      OR jsonb_typeof(model -> 'is_free') IS DISTINCT FROM 'boolean'
      OR model ? 'markup'
      OR model ? 'deduct_markup'
      OR (model ->> 'sort_order')::NUMERIC < 0
      OR (model ->> 'sort_order')::NUMERIC <> trunc((model ->> 'sort_order')::NUMERIC)
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog contains invalid PRD model fields'
      USING ERRCODE = '22023';
  END IF;

  IF (
    SELECT count(*) <> count(DISTINCT model ->> 'openrouter_model_id')
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog OpenRouter mappings must be unique'
      USING ERRCODE = '22023';
  END IF;
END;
$function$


-- ==================== admin.validate_operations_config_draft_trigger() ====================
CREATE OR REPLACE FUNCTION admin.validate_operations_config_draft_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NEW.config_key = 'miniapp_recharge_page_config' THEN
    PERFORM admin.validate_recharge_page_config(NEW.value);
  END IF;
  RETURN NEW;
END;
$function$


-- ==================== admin.validate_payment_plan_ids(p_value jsonb) ====================
CREATE OR REPLACE FUNCTION admin.validate_payment_plan_ids(p_value jsonb)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF (
    SELECT count(*) <> count(DISTINCT plan ->> 'id')
    FROM jsonb_array_elements(p_value) AS plan
  ) THEN
    RAISE EXCEPTION 'miniapp_payment_plans plan ids must be unique'
      USING ERRCODE = '22023';
  END IF;
END;
$function$


-- ==================== admin.validate_payment_plans_draft_trigger() ====================
CREATE OR REPLACE FUNCTION admin.validate_payment_plans_draft_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NEW.config_key = 'miniapp_payment_plans' THEN
    PERFORM admin.validate_payment_plan_ids(NEW.value);
  END IF;
  RETURN NEW;
END;
$function$


-- ==================== admin.validate_payment_prompt_dialog_config(p_value jsonb) ====================
CREATE OR REPLACE FUNCTION admin.validate_payment_prompt_dialog_config(p_value jsonb)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF p_value IS NULL
     OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_value -> 'enabled') IS DISTINCT FROM 'boolean'
     OR COALESCE(char_length(trim(p_value ->> 'title')), 0) NOT BETWEEN 1 AND 40
     OR COALESCE(char_length(trim(p_value ->> 'description')), 0) NOT BETWEEN 1 AND 200
     OR COALESCE(char_length(trim(p_value ->> 'confirm_text')), 0) NOT BETWEEN 1 AND 30
     OR COALESCE(char_length(trim(p_value ->> 'footer_note')), 0) NOT BETWEEN 1 AND 100
     OR COALESCE(p_value ->> 'accent_color', '') !~ '^#[0-9A-Fa-f]{6}$' THEN
    RAISE EXCEPTION 'miniapp_payment_prompt_dialog_config is invalid'
      USING ERRCODE = '22023';
  END IF;
END;
$function$


-- ==================== admin.validate_platform_preset_payload(p_payload jsonb) ====================
CREATE OR REPLACE FUNCTION admin.validate_platform_preset_payload(p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
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
$function$


-- ==================== admin.validate_recharge_page_config(p_value jsonb) ====================
CREATE OR REPLACE FUNCTION admin.validate_recharge_page_config(p_value jsonb)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF p_value IS NULL
     OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
     OR COALESCE(char_length(trim(p_value ->> 'title')), 0) NOT BETWEEN 1 AND 30
     OR COALESCE(char_length(trim(p_value ->> 'description')), 0) NOT BETWEEN 1 AND 120
     OR COALESCE(char_length(trim(p_value ->> 'button_text')), 0) NOT BETWEEN 1 AND 20
     OR COALESCE(p_value ->> 'theme_color', '') !~ '^#[0-9A-Fa-f]{6}$'
     OR COALESCE(p_value ->> 'balance_color', '') !~ '^#[0-9A-Fa-f]{6}$'
     OR COALESCE(p_value ->> 'selected_plan_color', '') !~ '^#[0-9A-Fa-f]{6}$'
     OR COALESCE(p_value ->> 'badge_color', '') !~ '^#[0-9A-Fa-f]{6}$'
     OR COALESCE(p_value ->> 'button_color', '') !~ '^#[0-9A-Fa-f]{6}$' THEN
    RAISE EXCEPTION 'miniapp_recharge_page_config is invalid'
      USING ERRCODE = '22023';
  END IF;
END;
$function$


-- ==================== admin.validate_voice_config_value(p_config_key text, p_value jsonb) ====================
CREATE OR REPLACE FUNCTION admin.validate_voice_config_value(p_config_key text, p_value jsonb)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF p_config_key = 'voice_billing_enabled' THEN
    IF p_value IS NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'voice_billing_enabled must be a JSON boolean'
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key IN ('voice_generation_credits', 'voice_max_spoken_chars') THEN
    IF p_value IS NULL
       OR jsonb_typeof(p_value) IS DISTINCT FROM 'number'
       OR (p_value #>> '{}')::NUMERIC <> trunc((p_value #>> '{}')::NUMERIC)
       OR (p_value #>> '{}')::NUMERIC < 1 THEN
      RAISE EXCEPTION '% must be a positive JSON integer', p_config_key
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key IN ('voice_price_label', 'voice_over_limit_hint',
                      'voice_draft_failed_hint', 'voice_tts_failed_hint') THEN
    IF p_value IS NULL
       OR jsonb_typeof(p_value) IS DISTINCT FROM 'string'
       OR char_length(trim(p_value #>> '{}')) = 0 THEN
      RAISE EXCEPTION '% must be a nonempty JSON string', p_config_key
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  RAISE EXCEPTION 'unknown voice config key: %', p_config_key
    USING ERRCODE = '22023';
END;
$function$


-- ==================== cs_platform.normalize_persona_sql(p_sql text) ====================
CREATE OR REPLACE FUNCTION cs_platform.normalize_persona_sql(p_sql text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
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
$function$


-- ==================== cs_platform.refresh_persona_members(p_persona_id uuid, p_operator_id text) ====================
CREATE OR REPLACE FUNCTION cs_platform.refresh_persona_members(p_persona_id uuid, p_operator_id text DEFAULT 'system'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$


-- ==================== cs_platform.validate_persona_sql(p_sql text) ====================
CREATE OR REPLACE FUNCTION cs_platform.validate_persona_sql(p_sql text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
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
    WHERE value->>'Node Type' = 'ModifyTable'
       OR value->>'Operation' IN ('Insert', 'Update', 'Delete', 'Merge')
  )
  INTO v_has_modify_node;

  IF v_has_modify_node THEN
    RAISE EXCEPTION 'persona sql must be read-only SELECT'
      USING ERRCODE = '22023';
  END IF;
END;
$function$


-- ==================== miniapp_traffic.increment_click(p_source_id text) ====================
CREATE OR REPLACE FUNCTION miniapp_traffic.increment_click(p_source_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
    INSERT INTO miniapp_traffic.traffic_clicks (stat_date, source_id, clicks)
    VALUES (CURRENT_DATE, p_source_id, 1)
    ON CONFLICT (stat_date, source_id)
    DO UPDATE SET clicks = miniapp_traffic.traffic_clicks.clicks + 1,
                  updated_at = NOW();
END;
$function$


-- ==================== public.gin_extract_query_trgm(text, internal, smallint, internal, internal, internal, internal) ====================
CREATE OR REPLACE FUNCTION public.gin_extract_query_trgm(text, internal, smallint, internal, internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gin_extract_query_trgm$function$


-- ==================== public.gin_extract_value_trgm(text, internal) ====================
CREATE OR REPLACE FUNCTION public.gin_extract_value_trgm(text, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gin_extract_value_trgm$function$


-- ==================== public.gin_trgm_consistent(internal, smallint, text, integer, internal, internal, internal, internal) ====================
CREATE OR REPLACE FUNCTION public.gin_trgm_consistent(internal, smallint, text, integer, internal, internal, internal, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gin_trgm_consistent$function$


-- ==================== public.gin_trgm_triconsistent(internal, smallint, text, integer, internal, internal, internal) ====================
CREATE OR REPLACE FUNCTION public.gin_trgm_triconsistent(internal, smallint, text, integer, internal, internal, internal)
 RETURNS "char"
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gin_trgm_triconsistent$function$


-- ==================== public.gtrgm_compress(internal) ====================
CREATE OR REPLACE FUNCTION public.gtrgm_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_compress$function$


-- ==================== public.gtrgm_consistent(internal, text, smallint, oid, internal) ====================
CREATE OR REPLACE FUNCTION public.gtrgm_consistent(internal, text, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_consistent$function$


-- ==================== public.gtrgm_decompress(internal) ====================
CREATE OR REPLACE FUNCTION public.gtrgm_decompress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_decompress$function$


-- ==================== public.gtrgm_distance(internal, text, smallint, oid, internal) ====================
CREATE OR REPLACE FUNCTION public.gtrgm_distance(internal, text, smallint, oid, internal)
 RETURNS double precision
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_distance$function$


-- ==================== public.gtrgm_in(cstring) ====================
CREATE OR REPLACE FUNCTION public.gtrgm_in(cstring)
 RETURNS gtrgm
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_in$function$


-- ==================== public.gtrgm_options(internal) ====================
CREATE OR REPLACE FUNCTION public.gtrgm_options(internal)
 RETURNS void
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE
AS '$libdir/pg_trgm', $function$gtrgm_options$function$


-- ==================== public.gtrgm_out(gtrgm) ====================
CREATE OR REPLACE FUNCTION public.gtrgm_out(gtrgm)
 RETURNS cstring
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_out$function$


-- ==================== public.gtrgm_penalty(internal, internal, internal) ====================
CREATE OR REPLACE FUNCTION public.gtrgm_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_penalty$function$


-- ==================== public.gtrgm_picksplit(internal, internal) ====================
CREATE OR REPLACE FUNCTION public.gtrgm_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_picksplit$function$


-- ==================== public.gtrgm_same(gtrgm, gtrgm, internal) ====================
CREATE OR REPLACE FUNCTION public.gtrgm_same(gtrgm, gtrgm, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_same$function$


-- ==================== public.gtrgm_union(internal, internal) ====================
CREATE OR REPLACE FUNCTION public.gtrgm_union(internal, internal)
 RETURNS gtrgm
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$gtrgm_union$function$


-- ==================== public.set_limit(real) ====================
CREATE OR REPLACE FUNCTION public.set_limit(real)
 RETURNS real
 LANGUAGE c
 STRICT
AS '$libdir/pg_trgm', $function$set_limit$function$


-- ==================== public.show_limit() ====================
CREATE OR REPLACE FUNCTION public.show_limit()
 RETURNS real
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$show_limit$function$


-- ==================== public.show_trgm(text) ====================
CREATE OR REPLACE FUNCTION public.show_trgm(text)
 RETURNS text[]
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$show_trgm$function$


-- ==================== public.similarity(text, text) ====================
CREATE OR REPLACE FUNCTION public.similarity(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$similarity$function$


-- ==================== public.similarity_dist(text, text) ====================
CREATE OR REPLACE FUNCTION public.similarity_dist(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$similarity_dist$function$


-- ==================== public.similarity_op(text, text) ====================
CREATE OR REPLACE FUNCTION public.similarity_op(text, text)
 RETURNS boolean
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$similarity_op$function$


-- ==================== public.strict_word_similarity(text, text) ====================
CREATE OR REPLACE FUNCTION public.strict_word_similarity(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$strict_word_similarity$function$


-- ==================== public.strict_word_similarity_commutator_op(text, text) ====================
CREATE OR REPLACE FUNCTION public.strict_word_similarity_commutator_op(text, text)
 RETURNS boolean
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$strict_word_similarity_commutator_op$function$


-- ==================== public.strict_word_similarity_dist_commutator_op(text, text) ====================
CREATE OR REPLACE FUNCTION public.strict_word_similarity_dist_commutator_op(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$strict_word_similarity_dist_commutator_op$function$


-- ==================== public.strict_word_similarity_dist_op(text, text) ====================
CREATE OR REPLACE FUNCTION public.strict_word_similarity_dist_op(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$strict_word_similarity_dist_op$function$


-- ==================== public.strict_word_similarity_op(text, text) ====================
CREATE OR REPLACE FUNCTION public.strict_word_similarity_op(text, text)
 RETURNS boolean
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$strict_word_similarity_op$function$


-- ==================== public.word_similarity(text, text) ====================
CREATE OR REPLACE FUNCTION public.word_similarity(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$word_similarity$function$


-- ==================== public.word_similarity_commutator_op(text, text) ====================
CREATE OR REPLACE FUNCTION public.word_similarity_commutator_op(text, text)
 RETURNS boolean
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$word_similarity_commutator_op$function$


-- ==================== public.word_similarity_dist_commutator_op(text, text) ====================
CREATE OR REPLACE FUNCTION public.word_similarity_dist_commutator_op(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$word_similarity_dist_commutator_op$function$


-- ==================== public.word_similarity_dist_op(text, text) ====================
CREATE OR REPLACE FUNCTION public.word_similarity_dist_op(text, text)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$word_similarity_dist_op$function$


-- ==================== public.word_similarity_op(text, text) ====================
CREATE OR REPLACE FUNCTION public.word_similarity_op(text, text)
 RETURNS boolean
 LANGUAGE c
 STABLE PARALLEL SAFE STRICT
AS '$libdir/pg_trgm', $function$word_similarity_op$function$


