-- Local prerequisite shape for the text-postprocess migrations.
-- Never apply this file to test or production. It is not a migration.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres NOSUPERUSER BYPASSRLS NOLOGIN;
  END IF;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS admin;
CREATE SCHEMA IF NOT EXISTS app_core;
CREATE SCHEMA IF NOT EXISTS experience;

GRANT USAGE ON SCHEMA admin, app_core, experience TO anon, authenticated, service_role, postgres;

CREATE TABLE IF NOT EXISTS admin.environment_config (
  id smallint PRIMARY KEY CHECK (id = 1),
  environment text NOT NULL CHECK (environment IN ('test', 'production'))
);

INSERT INTO admin.environment_config (id, environment)
VALUES (1, 'test')
ON CONFLICT (id) DO UPDATE SET environment = EXCLUDED.environment;

CREATE TABLE IF NOT EXISTS admin.admin_users (
  user_id uuid PRIMARY KEY,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'operator', 'viewer')),
  can_access_test boolean NOT NULL DEFAULT true,
  can_access_prod boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS admin.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid,
  actor_email text NOT NULL,
  environment text NOT NULL,
  action text NOT NULL,
  schema_name text NOT NULL,
  table_name text NOT NULL,
  record_id text NOT NULL,
  before_value jsonb,
  after_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin.config_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL CHECK (environment IN ('test', 'production')),
  config_key text NOT NULL,
  value jsonb,
  text_value text,
  description text,
  base_version integer NOT NULL DEFAULT 0 CHECK (base_version >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_by uuid NOT NULL REFERENCES admin.admin_users (user_id),
  updated_by uuid NOT NULL REFERENCES admin.admin_users (user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT config_drafts_config_key_check CHECK (config_key IN ('system_instructions')),
  CHECK (value IS NOT NULL OR text_value IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS admin.config_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL CHECK (environment IN ('test', 'production')),
  config_key text NOT NULL,
  runtime_version integer NOT NULL CHECK (runtime_version > 0),
  value jsonb,
  text_value text,
  description text,
  source_draft_id uuid REFERENCES admin.config_drafts (id),
  rollback_of_release_id uuid REFERENCES admin.config_releases (id),
  released_by uuid NOT NULL REFERENCES admin.admin_users (user_id),
  released_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT config_releases_config_key_check CHECK (config_key IN ('system_instructions')),
  UNIQUE (environment, config_key, runtime_version),
  CHECK (value IS NOT NULL OR text_value IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_config_drafts_one_active
  ON admin.config_drafts (environment, config_key)
  WHERE status = 'draft';

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_config_releases_source_draft
  ON admin.config_releases (source_draft_id)
  WHERE source_draft_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_core.runtime_config (
  key text PRIMARY KEY,
  value jsonb,
  description text,
  version integer DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  text_value text
);

CREATE OR REPLACE FUNCTION admin.current_environment()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_environment text;
BEGIN
  SELECT config.environment
    INTO v_environment
  FROM admin.environment_config AS config
  WHERE config.id = 1;
  IF NOT FOUND OR v_environment NOT IN ('test', 'production') THEN
    RAISE EXCEPTION 'admin environment is not configured' USING ERRCODE = '55000';
  END IF;
  RETURN v_environment;
END;
$fn$;

CREATE OR REPLACE FUNCTION admin.is_managed_config_key(p_config_key text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $fn$
  SELECT p_config_key IN ('system_instructions');
$fn$;

CREATE OR REPLACE FUNCTION admin.validate_managed_config_value(
  p_config_key text,
  p_value jsonb,
  p_text_value text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF p_config_key = 'system_instructions' THEN
    RETURN;
  END IF;
  RAISE EXCEPTION 'config key is not managed by admin: %', p_config_key USING ERRCODE = '22023';
END;
$fn$;

CREATE OR REPLACE FUNCTION admin.publish_config_draft(p_draft_id uuid)
RETURNS admin.config_releases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_draft admin.config_drafts%ROWTYPE;
  v_release admin.config_releases%ROWTYPE;
BEGIN
  SELECT draft.*
    INTO v_draft
  FROM admin.config_drafts AS draft
  WHERE draft.id = p_draft_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'config draft not found: %', p_draft_id USING ERRCODE = 'P0002';
  END IF;
  IF admin.is_managed_config_key(v_draft.config_key) IS NOT TRUE THEN
    RAISE EXCEPTION 'config draft contains an invalid environment or config key'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO admin.config_releases (
    environment, config_key, runtime_version, value, text_value, description, source_draft_id, released_by
  ) VALUES (
    v_draft.environment,
    v_draft.config_key,
    1,
    COALESCE(v_draft.value, 'null'::jsonb),
    v_draft.text_value,
    v_draft.description,
    v_draft.id,
    v_draft.updated_by
  )
  RETURNING * INTO v_release;
  RETURN v_release;
END;
$fn$;

CREATE OR REPLACE FUNCTION admin.rollback_config_release(p_release_id uuid)
RETURNS admin.config_releases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_target admin.config_releases%ROWTYPE;
  v_release admin.config_releases%ROWTYPE;
BEGIN
  SELECT release.*
    INTO v_target
  FROM admin.config_releases AS release
  WHERE release.id = p_release_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'config release not found: %', p_release_id USING ERRCODE = 'P0002';
  END IF;
  IF admin.is_managed_config_key(v_target.config_key) IS NOT TRUE THEN
    RAISE EXCEPTION 'config release contains an invalid environment or config key'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO admin.config_releases (
    environment, config_key, runtime_version, value, text_value, description, rollback_of_release_id, released_by
  ) VALUES (
    v_target.environment,
    v_target.config_key,
    v_target.runtime_version + 1,
    COALESCE(v_target.value, 'null'::jsonb),
    v_target.text_value,
    v_target.description,
    v_target.id,
    v_target.released_by
  )
  RETURNING * INTO v_release;
  RETURN v_release;
END;
$fn$;

CREATE OR REPLACE FUNCTION admin.upsert_config_draft(
  p_environment text,
  p_config_key text,
  p_value jsonb,
  p_text_value text DEFAULT NULL,
  p_description text DEFAULT NULL
) RETURNS admin.config_drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_actor uuid;
  v_draft admin.config_drafts%ROWTYPE;
BEGIN
  PERFORM admin.validate_managed_config_value(p_config_key, p_value, p_text_value);
  SELECT user_id INTO v_actor FROM admin.admin_users WHERE role = 'owner' LIMIT 1;
  INSERT INTO admin.config_drafts (
    environment, config_key, value, text_value, description, base_version, created_by, updated_by
  ) VALUES (
    p_environment, p_config_key, p_value, p_text_value, p_description, 0, v_actor, v_actor
  )
  RETURNING * INTO v_draft;
  RETURN v_draft;
END;
$fn$;

CREATE OR REPLACE FUNCTION admin.save_config_draft(
  p_environment text,
  p_config_key text,
  p_value jsonb,
  p_text_value text DEFAULT NULL,
  p_description text DEFAULT NULL
) RETURNS admin.config_drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_draft admin.config_drafts%ROWTYPE;
BEGIN
  PERFORM admin.validate_managed_config_value(
    p_config_key,
    p_value,
    p_text_value
  );
  RAISE EXCEPTION 'save stub is only present so the text-postprocess patch can find its anchor'
    USING ERRCODE = '0A000';
  RETURN v_draft;
END;
$fn$;

CREATE OR REPLACE FUNCTION admin.discard_config_draft(p_draft_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_draft admin.config_drafts%ROWTYPE;
BEGIN
  SELECT draft.*
    INTO v_draft
  FROM admin.config_drafts AS draft
  WHERE draft.id = p_draft_id
    AND draft.status = 'draft'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active draft not found' USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM admin.config_drafts WHERE id = v_draft.id;
  RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION admin.publish_config_draft(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.rollback_config_release(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.upsert_config_draft(text, text, jsonb, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.save_config_draft(text, text, jsonb, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.discard_config_draft(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.publish_config_draft(uuid) TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.rollback_config_release(uuid) TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.upsert_config_draft(text, text, jsonb, text, text) TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.save_config_draft(text, text, jsonb, text, text) TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.discard_config_draft(uuid) TO authenticated, service_role, postgres;

CREATE TABLE IF NOT EXISTS experience.chat_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  character_id uuid,
  deleted_at timestamptz,
  context_window_start_turn integer NOT NULL DEFAULT 1,
  hook_calls integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS experience.chat_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  model text NOT NULL,
  user_input text NOT NULL,
  assistant_reply text,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  character_id uuid,
  status text NOT NULL,
  session_id uuid,
  turn_index integer,
  revision integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  billing_only jsonb
);

CREATE OR REPLACE VIEW experience.current_chat_history
WITH (security_invoker = true) AS
SELECT DISTINCT ON (session_id, turn_index)
  id,
  user_id,
  model,
  user_input,
  assistant_reply,
  history,
  character_id,
  status,
  session_id,
  turn_index,
  revision,
  created_at
FROM experience.chat_history
WHERE session_id IS NOT NULL
  AND turn_index IS NOT NULL
  AND revision IS NOT NULL
ORDER BY session_id, turn_index, revision DESC;

REVOKE ALL ON experience.current_chat_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON experience.current_chat_history TO service_role, postgres;
GRANT ALL ON experience.chat_history TO service_role, postgres;
GRANT ALL ON experience.chat_sessions TO service_role, postgres;

CREATE OR REPLACE FUNCTION experience.start_chat_history_turn(
  p_session_id uuid,
  p_user_content text,
  p_model text,
  p_stale_after_seconds integer DEFAULT 120,
  p_max_context_turns integer DEFAULT 75,
  p_retain_context_turns integer DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_session experience.chat_sessions%ROWTYPE;
  v_turn integer;
  v_history_id uuid;
  v_window integer;
BEGIN
  IF p_session_id IS NULL
     OR btrim(COALESCE(p_user_content, '')) = ''
     OR btrim(COALESCE(p_model, '')) = '' THEN
    RAISE EXCEPTION 'invalid start_chat_history_turn input' USING ERRCODE = '22023';
  END IF;

  SELECT session.*
    INTO v_session
  FROM experience.chat_sessions AS session
  WHERE session.id = p_session_id
    AND session.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat session not found: %', p_session_id USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM experience.chat_history AS history
    WHERE history.session_id = p_session_id
      AND history.status = 'streaming'
      AND history.created_at > pg_catalog.now() - make_interval(secs => GREATEST(p_stale_after_seconds, 0))
  ) THEN
    RAISE EXCEPTION 'session busy' USING ERRCODE = '55000';
  END IF;

  UPDATE experience.chat_sessions
  SET hook_calls = hook_calls + 1,
      context_window_start_turn = CASE
        WHEN p_max_context_turns < 5 THEN 9
        ELSE context_window_start_turn
      END
  WHERE id = p_session_id
  RETURNING context_window_start_turn INTO v_window;

  SELECT COALESCE(max(history.turn_index), 0) + 1
    INTO v_turn
  FROM experience.chat_history AS history
  WHERE history.session_id = p_session_id
    AND history.turn_index IS NOT NULL;

  INSERT INTO experience.chat_history (
    user_id, model, user_input, assistant_reply, history, character_id,
    status, session_id, turn_index, revision
  ) VALUES (
    v_session.user_id, p_model, p_user_content, NULL, '[]'::jsonb, v_session.character_id,
    'streaming', p_session_id, v_turn, 0
  )
  RETURNING id INTO v_history_id;

  RETURN jsonb_build_object(
    'turn_index', v_turn,
    'history_id', v_history_id,
    'revision', 0,
    'context_window_start_turn', v_window
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION experience.start_chat_history_regeneration(
  p_session_id uuid,
  p_turn_index integer DEFAULT NULL,
  p_model text DEFAULT NULL,
  p_stale_after_seconds integer DEFAULT 120,
  p_max_context_turns integer DEFAULT 75,
  p_retain_context_turns integer DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_session experience.chat_sessions%ROWTYPE;
  v_last_turn integer;
  v_user_content text;
  v_revision integer;
  v_history_id uuid;
  v_window integer;
BEGIN
  IF p_session_id IS NULL OR btrim(COALESCE(p_model, '')) = '' THEN
    RAISE EXCEPTION 'invalid start_chat_history_regeneration input' USING ERRCODE = '22023';
  END IF;

  SELECT session.*
    INTO v_session
  FROM experience.chat_sessions AS session
  WHERE session.id = p_session_id
    AND session.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat session not found: %', p_session_id USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM experience.chat_history AS history
    WHERE history.session_id = p_session_id
      AND history.status = 'streaming'
      AND history.created_at > pg_catalog.now() - make_interval(secs => GREATEST(p_stale_after_seconds, 0))
  ) THEN
    RAISE EXCEPTION 'session busy' USING ERRCODE = '55000';
  END IF;

  SELECT max(history.turn_index)
    INTO v_last_turn
  FROM experience.chat_history AS history
  WHERE history.session_id = p_session_id
    AND history.turn_index IS NOT NULL;
  IF v_last_turn IS NULL OR (p_turn_index IS NOT NULL AND p_turn_index <> v_last_turn) THEN
    RAISE EXCEPTION 'only the last turn can be regenerated' USING ERRCODE = '55000';
  END IF;

  SELECT history.user_input
    INTO v_user_content
  FROM experience.chat_history AS history
  WHERE history.session_id = p_session_id
    AND history.turn_index = v_last_turn
  ORDER BY history.revision DESC
  LIMIT 1;

  UPDATE experience.chat_sessions
  SET hook_calls = hook_calls + 1,
      context_window_start_turn = CASE
        WHEN p_retain_context_turns < 5 THEN 8
        ELSE context_window_start_turn
      END
  WHERE id = p_session_id
  RETURNING context_window_start_turn INTO v_window;

  SELECT COALESCE(max(history.revision), -1) + 1
    INTO v_revision
  FROM experience.chat_history AS history
  WHERE history.session_id = p_session_id
    AND history.turn_index = v_last_turn;

  INSERT INTO experience.chat_history (
    user_id, model, user_input, assistant_reply, history, character_id,
    status, session_id, turn_index, revision
  ) VALUES (
    v_session.user_id, p_model, v_user_content, NULL, '[]'::jsonb, v_session.character_id,
    'streaming', p_session_id, v_last_turn, v_revision
  )
  RETURNING id INTO v_history_id;

  RETURN jsonb_build_object(
    'turn_index', v_last_turn,
    'history_id', v_history_id,
    'revision', v_revision,
    'user_content', v_user_content,
    'context_window_start_turn', v_window
  );
END;
$fn$;

REVOKE ALL ON FUNCTION experience.start_chat_history_turn(uuid, text, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION experience.start_chat_history_regeneration(uuid, integer, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.start_chat_history_turn(uuid, text, text, integer, integer, integer) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION experience.start_chat_history_regeneration(uuid, integer, text, integer, integer, integer) TO service_role, postgres;
