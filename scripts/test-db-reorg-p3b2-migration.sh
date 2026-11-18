#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261117_db_reorg_p3b2_user_profile.sql (+ _contract) as a NON-superuser with CREATEROLE:
# - expand is idempotent; users profile equals settings; cs_feed.user_identities and the two admin functions return
#   identical results, user_identities keeps security_barrier, grants and its dependent view;
# - refresh_user_profile writes nothing when Telegram data is unchanged;
# - the user_preferences view inserts with table defaults, enforces CHECKs and updates through to settings;
# - release window: old backend writes on settings reach users (INSERT only non-null, UPDATE only changed columns),
#   new writes on users reach settings, no loops; preference RPCs and start-turn functions keep working;
# - contract refuses while another function references settings, reconciles race leftovers, renames the table and
#   its constraints, drops profile columns, rewrites the 4 preference functions; everything still works; idempotent.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
expand="$task_root/packages/shared/migrations/20261117_db_reorg_p3b2_user_profile.sql"
contract="$task_root/packages/shared/migrations/20261117_db_reorg_p3b2_user_profile_contract.sql"
task_container="st-db-reorg-p3b2-${RANDOM}-$$"
trap 'docker rm -f "$task_container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
super_psql=(docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1)
admin_psql=(docker exec -i "$task_container" psql -X -q -U app_admin -d postgres -v ON_ERROR_STOP=1)

"${super_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE BYPASSRLS;
GRANT CREATE, CONNECT ON DATABASE postgres TO app_admin;
SQL

# Fixture mirrors the production shape collected on 2026-11-17 (after 3b-1).
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE cs_runtime_v1 NOLOGIN;
GRANT service_role, anon, authenticated, cs_runtime_v1 TO app_admin;
CREATE SCHEMA app_core; CREATE SCHEMA cs_feed; CREATE SCHEMA admin; CREATE SCHEMA experience;
CREATE SCHEMA miniapp_traffic; CREATE SCHEMA test_fixture;
GRANT USAGE ON SCHEMA app_core, cs_feed, admin, experience, miniapp_traffic TO service_role;
GRANT USAGE ON SCHEMA cs_feed TO cs_runtime_v1;

CREATE TABLE app_core.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tg_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
GRANT ALL ON app_core.users TO service_role;
CREATE FUNCTION app_core.is_valid_reply_style_preferences(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS
  $$ SELECT jsonb_typeof(p) = 'object' AND NOT EXISTS (SELECT 1 FROM jsonb_each(p) e WHERE jsonb_typeof(e.value) <> 'boolean') $$;
CREATE TABLE app_core.miniapp_user_settings (
  user_id uuid NOT NULL,
  tg_username text, tg_first_name text, tg_last_name text, display_name text, avatar_url text,
  pref_word_count text,
  pref_show_options boolean NOT NULL DEFAULT true,
  pref_custom_instructions text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  selected_model_id text, tg_avatar_url text, custom_avatar_url text, pref_voice_id text,
  pref_voice_playback_rate numeric NOT NULL DEFAULT 1.0,
  pref_show_status boolean NOT NULL DEFAULT true,
  pref_show_memory boolean NOT NULL DEFAULT true,
  pref_reply_styles jsonb NOT NULL DEFAULT '{}'::jsonb,
  pref_drive_mode text,
  CONSTRAINT miniapp_user_settings_pkey PRIMARY KEY (user_id),
  CONSTRAINT miniapp_user_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES app_core.users(id) ON DELETE CASCADE,
  CONSTRAINT miniapp_user_settings_pref_drive_mode_check CHECK (pref_drive_mode IS NULL OR pref_drive_mode ~ '^[a-z][a-z0-9-]{0,31}$'),
  CONSTRAINT miniapp_user_settings_pref_reply_styles_check CHECK (app_core.is_valid_reply_style_preferences(pref_reply_styles)),
  CONSTRAINT miniapp_user_settings_pref_voice_playback_rate_check CHECK (pref_voice_playback_rate >= 0.5 AND pref_voice_playback_rate <= 2.0),
  CONSTRAINT miniapp_user_settings_pref_word_count_nonempty_check CHECK (pref_word_count IS NULL OR char_length(btrim(pref_word_count)) > 0));
ALTER TABLE app_core.miniapp_user_settings ENABLE ROW LEVEL SECURITY;
GRANT ALL ON app_core.miniapp_user_settings TO service_role;

CREATE FUNCTION app_core.update_instruction_slot_preferences(p_user_id uuid, p_pref_show_options boolean DEFAULT NULL::boolean,
  p_pref_show_status boolean DEFAULT NULL::boolean, p_pref_show_memory boolean DEFAULT NULL::boolean)
 RETURNS TABLE(pref_show_options boolean, pref_show_status boolean, pref_show_memory boolean)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog' AS $function$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user id is required' USING ERRCODE = '22023';
  END IF;
  UPDATE app_core.miniapp_user_settings AS settings
  SET pref_show_options = COALESCE(p_pref_show_options, settings.pref_show_options),
      pref_show_status = COALESCE(p_pref_show_status, settings.pref_show_status),
      pref_show_memory = COALESCE(p_pref_show_memory, settings.pref_show_memory),
      updated_at = pg_catalog.now()
  WHERE settings.user_id = p_user_id
  RETURNING settings.pref_show_options, settings.pref_show_status, settings.pref_show_memory
    INTO pref_show_options, pref_show_status, pref_show_memory;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'miniapp user settings not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN NEXT;
END;
$function$;
CREATE FUNCTION app_core.update_reply_style_preferences(p_user_id uuid, p_patch jsonb)
 RETURNS void LANGUAGE plpgsql SET search_path TO 'pg_catalog' AS $function$
BEGIN
  IF p_user_id IS NULL OR NOT app_core.is_valid_reply_style_preferences(p_patch) THEN
    RAISE EXCEPTION 'reply style preferences must be an object of at most 64 valid boolean options'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO app_core.miniapp_user_settings(user_id, pref_reply_styles, updated_at)
  VALUES (p_user_id, p_patch, now())
  ON CONFLICT (user_id) DO UPDATE SET
    pref_reply_styles = app_core.miniapp_user_settings.pref_reply_styles || EXCLUDED.pref_reply_styles,
    updated_at = now();
END;
$function$;
-- Start-turn functions reduced to the two statements that touch settings (production lines verbatim).
CREATE FUNCTION experience.start_chat_history_turn_with_current_postprocess(p_session_id uuid, p_user_content text, p_model text,
  p_stale_after_seconds integer DEFAULT 120, p_max_context_turns integer DEFAULT 75, p_retain_context_turns integer DEFAULT 50)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog' AS $function$
DECLARE
  v_user_id uuid := p_session_id;
  v_settings record; v_previous_exact boolean := false; v_mode text := 'full';
BEGIN
  INSERT INTO app_core.miniapp_user_settings (user_id) VALUES (v_user_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT pref_show_options, pref_show_status, pref_show_memory INTO v_settings FROM app_core.miniapp_user_settings WHERE user_id = v_user_id FOR SHARE;
  RETURN jsonb_build_object(
    'choice_rules_mode', CASE WHEN v_settings.pref_show_options THEN v_mode ELSE 'off' END,
    'status_rules_mode', CASE WHEN v_settings.pref_show_status THEN v_mode ELSE 'off' END,
    'memory_rules_mode', CASE WHEN v_settings.pref_show_memory THEN v_mode ELSE 'off' END);
END;
$function$;
CREATE FUNCTION experience.start_chat_history_regeneration_with_current_postprocess(p_session_id uuid, p_turn_index integer, p_model text,
  p_stale_after_seconds integer DEFAULT 120, p_max_context_turns integer DEFAULT 75, p_retain_context_turns integer DEFAULT 50)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog' AS $function$
DECLARE
  v_user_id uuid := p_session_id;
  v_settings record; v_previous_exact boolean := false; v_mode text := 'concise';
BEGIN
  INSERT INTO app_core.miniapp_user_settings (user_id) VALUES (v_user_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT pref_show_options, pref_show_status, pref_show_memory INTO v_settings FROM app_core.miniapp_user_settings WHERE user_id = v_user_id FOR SHARE;
  RETURN jsonb_build_object('choice_rules_mode', CASE WHEN v_settings.pref_show_options THEN v_mode ELSE 'off' END);
END;
$function$;

-- Admin readers reduced to the parts that read settings (join lines verbatim).
CREATE TABLE miniapp_traffic.invite_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), inviter_user_id uuid NOT NULL, invitee_user_id uuid NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION admin.lookup_user_for_credit_grant(p_identifier text)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog' AS $function$
DECLARE
  v_user app_core.users%ROWTYPE;
BEGIN
  SELECT app_user.* INTO v_user FROM app_core.users AS app_user WHERE app_user.tg_id = p_identifier;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;
  RETURN (
    SELECT jsonb_build_object(
      'found', true,
      'user_id', v_user.id,
      'display_name', COALESCE(settings.display_name, settings.tg_first_name),
      'tg_username', settings.tg_username
    )
    FROM (SELECT 1) AS anchor
    LEFT JOIN app_core.miniapp_user_settings AS settings ON settings.user_id = v_user.id
  );
END;
$function$;
CREATE FUNCTION admin.list_invite_records(p_inviter_ref text DEFAULT NULL::text, p_invitee_ref text DEFAULT NULL::text,
  p_bound_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_bound_to timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_reward_status text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(relation_id uuid, inviter_tg_id text, inviter_display_name text, invitee_tg_id text, invitee_display_name text)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog' AS $function$
BEGIN
  RETURN QUERY
  SELECT
    r.id,
    ui.tg_id,
    COALESCE(si.display_name, si.tg_first_name),
    uv.tg_id,
    COALESCE(sv.display_name, sv.tg_first_name)
  FROM miniapp_traffic.invite_relations AS r
  JOIN app_core.users AS ui ON ui.id = r.inviter_user_id
  JOIN app_core.users AS uv ON uv.id = r.invitee_user_id
  LEFT JOIN app_core.miniapp_user_settings AS si ON si.user_id = r.inviter_user_id
  LEFT JOIN app_core.miniapp_user_settings AS sv ON sv.user_id = r.invitee_user_id
  ORDER BY r.bound_at DESC
  LIMIT p_limit OFFSET p_offset;
END;
$function$;

CREATE VIEW cs_feed.user_identities WITH (security_barrier = true) AS
  SELECT u.id AS user_id, u.tg_id,
    COALESCE(NULLIF(s.display_name, ''::text), NULLIF(s.tg_username, ''::text), NULLIF(s.tg_first_name, ''::text)) AS display_name,
    NULLIF(s.tg_username, ''::text) AS username
  FROM app_core.users u LEFT JOIN app_core.miniapp_user_settings s ON s.user_id = u.id;
COMMENT ON VIEW cs_feed.user_identities IS '客服用：用户身份与展示名。';
CREATE VIEW cs_feed.user_profiles WITH (security_barrier = true) AS
  SELECT i.user_id, i.tg_id, i.display_name, i.username FROM cs_feed.user_identities i;
GRANT SELECT ON cs_feed.user_identities, cs_feed.user_profiles TO service_role, cs_runtime_v1;

-- Data: 40 users, 36 with settings; profile values spread (nulls, empty strings, custom avatars).
INSERT INTO app_core.users (tg_id) SELECT (1000 + g)::text FROM generate_series(1, 40) g;
INSERT INTO app_core.miniapp_user_settings (user_id, tg_username, tg_first_name, tg_last_name, display_name, avatar_url,
  tg_avatar_url, custom_avatar_url, selected_model_id, pref_word_count, pref_reply_styles)
SELECT u.id,
  CASE WHEN n % 3 = 0 THEN 'user' || n WHEN n % 3 = 1 THEN '' END,
  'First' || n, CASE WHEN n % 2 = 0 THEN 'Last' || n END,
  CASE WHEN n % 4 = 0 THEN 'Nick' || n WHEN n % 4 = 1 THEN '' END,
  CASE WHEN n % 5 = 0 THEN 'https://t.me/i/userpic/old' || n END,
  CASE WHEN n % 2 = 1 THEN 'https://t.me/i/userpic/' || n END,
  CASE WHEN n % 7 = 0 THEN 'https://storage/avatar' || n END,
  CASE WHEN n % 3 = 0 THEN 'model-a' END, CASE WHEN n % 2 = 0 THEN '300-500' END,
  CASE WHEN n % 5 = 0 THEN '{"style-a": true}'::jsonb ELSE '{}'::jsonb END
FROM (SELECT id, tg_id::int - 1000 AS n FROM app_core.users) u WHERE n <= 36;
INSERT INTO miniapp_traffic.invite_relations (inviter_user_id, invitee_user_id, bound_at)
SELECT a.id, b.id, now() - (n || ' hours')::interval
FROM generate_series(1, 12) n
JOIN app_core.users a ON a.tg_id = (1000 + n)::text JOIN app_core.users b ON b.tg_id = (1020 + n)::text;

CREATE TABLE test_fixture.identities_before AS SELECT * FROM cs_feed.user_identities;
CREATE TABLE test_fixture.lookup_before AS
  SELECT u.tg_id, admin.lookup_user_for_credit_grant(u.tg_id) AS j FROM app_core.users u;
CREATE TABLE test_fixture.invites_before AS SELECT * FROM admin.list_invite_records(NULL, NULL, NULL, NULL, NULL, 200, 0);
CREATE TABLE test_fixture.settings_before AS SELECT * FROM app_core.miniapp_user_settings;
CREATE FUNCTION test_fixture.uid(t text) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM app_core.users WHERE tg_id = t $$;
SQL

"${admin_psql[@]}" >/dev/null < "$expand"
"${admin_psql[@]}" >/dev/null < "$expand"

"${admin_psql[@]}" <<'SQL'
\set QUIET on
DO $after_expand$
BEGIN
  IF EXISTS (SELECT 1 FROM test_fixture.settings_before s JOIN app_core.users u ON u.id = s.user_id
             WHERE (u.tg_username, u.tg_first_name, u.tg_last_name, u.tg_avatar_url, u.display_name, u.custom_avatar_url)
                   IS DISTINCT FROM (s.tg_username, s.tg_first_name, s.tg_last_name, s.tg_avatar_url, s.display_name, s.custom_avatar_url))
     OR EXISTS (SELECT 1 FROM app_core.users u WHERE u.tg_id::int > 1036 AND (u.tg_first_name IS NOT NULL OR u.display_name IS NOT NULL)) THEN
    RAISE EXCEPTION 'profile backfill differs';
  END IF;
  IF EXISTS (SELECT * FROM test_fixture.identities_before EXCEPT SELECT * FROM cs_feed.user_identities)
     OR EXISTS (SELECT * FROM cs_feed.user_identities EXCEPT SELECT * FROM test_fixture.identities_before) THEN
    RAISE EXCEPTION 'cs_feed.user_identities output changed';
  END IF;
  IF NOT (SELECT 'security_barrier=true' = ANY (reloptions) FROM pg_class WHERE oid = 'cs_feed.user_identities'::regclass)
     OR NOT has_table_privilege('cs_runtime_v1', 'cs_feed.user_identities', 'SELECT')
     OR (SELECT count(*) FROM cs_feed.user_profiles) <> 40 THEN
    RAISE EXCEPTION 'user_identities options/grants/dependents lost';
  END IF;
  IF EXISTS (SELECT 1 FROM test_fixture.lookup_before b WHERE b.j IS DISTINCT FROM admin.lookup_user_for_credit_grant(b.tg_id))
     OR EXISTS (SELECT * FROM test_fixture.invites_before EXCEPT SELECT * FROM admin.list_invite_records(NULL, NULL, NULL, NULL, NULL, 200, 0))
     OR (SELECT count(*) FROM admin.list_invite_records(NULL, NULL, NULL, NULL, NULL, 200, 0)) <> 12
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'admin.lookup_user_for_credit_grant(text)'::regprocedure) ~ 'miniapp_user_settings' THEN
    RAISE EXCEPTION 'admin functions changed output or still read settings';
  END IF;
  IF has_function_privilege('anon', 'app_core.refresh_user_profile(uuid,text,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'app_core.refresh_user_profile(uuid,text,text,text,text)', 'EXECUTE')
     OR NOT has_table_privilege('service_role', 'app_core.user_preferences', 'INSERT')
     OR has_table_privilege('anon', 'app_core.user_preferences', 'SELECT') THEN
    RAISE EXCEPTION 'grants wrong';
  END IF;
END $after_expand$;

-- refresh_user_profile: unchanged Telegram data writes nothing; changed data writes and syncs back to settings.
CREATE TABLE test_fixture.xmin_before AS SELECT xmin::text AS x FROM app_core.users WHERE tg_id = '1003';
SELECT app_core.refresh_user_profile(test_fixture.uid('1003'), 'user3', 'First3', NULL, 'https://t.me/i/userpic/3') \g /dev/null
SELECT (SELECT xmin::text FROM app_core.users WHERE tg_id = '1003') = (SELECT x FROM test_fixture.xmin_before) AS no_write \gset
\if :no_write
\else
  \echo 'refresh_user_profile wrote unchanged data'
  SELECT 1 / 0;
\endif
SELECT app_core.refresh_user_profile(test_fixture.uid('1005'), 'renamed5', 'First5', NULL, NULL) ->> 'tg_username' AS u5 \gset
SELECT (:'u5' = 'renamed5'
  AND (SELECT tg_username FROM app_core.miniapp_user_settings WHERE user_id = test_fixture.uid('1005')) = 'renamed5'
  AND (SELECT tg_avatar_url FROM app_core.miniapp_user_settings WHERE user_id = test_fixture.uid('1005')) IS NULL
  AND (SELECT display_name FROM app_core.miniapp_user_settings WHERE user_id = test_fixture.uid('1005')) = '') AS refresh_ok \gset
\if :refresh_ok
\else
  \echo 'refresh_user_profile change not applied or not synced'
  SELECT 1 / 0;
\endif

-- user_preferences view: insert with table defaults, CHECKs enforced, updates land in settings.
INSERT INTO app_core.user_preferences (user_id) VALUES (test_fixture.uid('1037'));
UPDATE app_core.user_preferences SET selected_model_id = 'model-b', pref_drive_mode = 'story' WHERE user_id = test_fixture.uid('1037');
DO $view$
DECLARE s record;
BEGIN
  SELECT * INTO s FROM app_core.miniapp_user_settings WHERE user_id = test_fixture.uid('1037');
  IF NOT s.pref_show_options OR s.pref_voice_playback_rate <> 1.0 OR s.pref_reply_styles <> '{}'::jsonb
     OR s.selected_model_id <> 'model-b' OR s.pref_drive_mode <> 'story' THEN
    RAISE EXCEPTION 'view insert/update wrong: %', row_to_json(s);
  END IF;
  BEGIN
    UPDATE app_core.user_preferences SET pref_drive_mode = 'BAD MODE' WHERE user_id = test_fixture.uid('1037');
    RAISE EXCEPTION 'check bypassed through view';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $view$;

-- Release window: old backend writes on settings.
UPDATE app_core.miniapp_user_settings SET display_name = 'OldNick8', updated_at = now() WHERE user_id = test_fixture.uid('1008');
UPDATE app_core.miniapp_user_settings SET custom_avatar_url = NULL WHERE user_id = test_fixture.uid('1007');
UPDATE app_core.miniapp_user_settings SET tg_username = 'user9', tg_first_name = 'First9', tg_last_name = NULL,
  tg_avatar_url = NULL, updated_at = now() WHERE user_id = test_fixture.uid('1009');
INSERT INTO app_core.miniapp_user_settings (user_id, tg_username, tg_first_name) VALUES (test_fixture.uid('1038'), 'u38', 'F38');
-- New backend writes on users; a fresh preference row from the new backend must not blank the profile.
UPDATE app_core.users SET display_name = 'NewNick10', updated_at = now() WHERE tg_id = '1010';
UPDATE app_core.users SET tg_first_name = 'F39', display_name = 'N39' WHERE tg_id = '1039';
INSERT INTO app_core.user_preferences (user_id) VALUES (test_fixture.uid('1039'));
SELECT * FROM app_core.update_instruction_slot_preferences(test_fixture.uid('1011'), false, NULL, NULL) \g /dev/null
SELECT app_core.update_reply_style_preferences(test_fixture.uid('1010'), '{"style-b": true}') \g /dev/null
SELECT experience.start_chat_history_turn_with_current_postprocess(test_fixture.uid('1040'), 'hi', 'm') \g /dev/null
DO $window$
BEGIN
  IF (SELECT display_name FROM app_core.users WHERE tg_id = '1008') <> 'OldNick8'
     OR (SELECT custom_avatar_url FROM app_core.users WHERE tg_id = '1007') IS NOT NULL
     OR (SELECT tg_avatar_url FROM app_core.users WHERE tg_id = '1009') IS NOT NULL
     OR (SELECT tg_first_name FROM app_core.users WHERE tg_id = '1038') <> 'F38' THEN
    RAISE EXCEPTION 'old settings writes not synced to users';
  END IF;
  IF (SELECT display_name FROM app_core.miniapp_user_settings WHERE user_id = test_fixture.uid('1010')) <> 'NewNick10'
     OR (SELECT pref_reply_styles FROM app_core.miniapp_user_settings WHERE user_id = test_fixture.uid('1010')) <> '{"style-a": true, "style-b": true}' THEN
    RAISE EXCEPTION 'new users writes not synced to settings';
  END IF;
  IF (SELECT display_name FROM app_core.users WHERE tg_id = '1039') <> 'N39'
     OR (SELECT tg_first_name FROM app_core.users WHERE tg_id = '1039') <> 'F39' THEN
    RAISE EXCEPTION 'new preference row blanked the profile';
  END IF;
  IF (SELECT pref_show_options FROM app_core.miniapp_user_settings WHERE user_id = test_fixture.uid('1011'))
     OR NOT EXISTS (SELECT 1 FROM app_core.miniapp_user_settings WHERE user_id = test_fixture.uid('1040')) THEN
    RAISE EXCEPTION 'preference functions broken in window';
  END IF;
  -- Window invariant: every settings row carries the same profile as users (contract relies on it).
  IF EXISTS (SELECT 1 FROM app_core.miniapp_user_settings s JOIN app_core.users u ON u.id = s.user_id
             WHERE (u.tg_username, u.tg_first_name, u.tg_last_name, u.tg_avatar_url, u.display_name, u.custom_avatar_url)
                   IS DISTINCT FROM (s.tg_username, s.tg_first_name, s.tg_last_name, s.tg_avatar_url, s.display_name, s.custom_avatar_url)) THEN
    RAISE EXCEPTION 'settings and users profiles diverged in the window';
  END IF;
END $window$;
SQL
echo 'OK: expand'

# Race leftover (written to settings while the sync trigger was not there yet).
"${admin_psql[@]}" >/dev/null <<'SQL'
ALTER TABLE app_core.miniapp_user_settings DISABLE TRIGGER settings_sync_profile;
UPDATE app_core.miniapp_user_settings SET display_name = 'RaceNick12' WHERE user_id = test_fixture.uid('1012');
ALTER TABLE app_core.miniapp_user_settings ENABLE TRIGGER settings_sync_profile;
CREATE TABLE test_fixture.identities_mid AS SELECT * FROM cs_feed.user_identities;
SQL

# Contract refuses while another function still reads settings.
"${admin_psql[@]}" -c "CREATE FUNCTION test_fixture.legacy_reader() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM app_core.miniapp_user_settings'" >/dev/null
if "${admin_psql[@]}" >/dev/null 2>&1 < "$contract"; then echo 'contract ran while a function reads settings' >&2; exit 1; fi
"${admin_psql[@]}" -c "DROP FUNCTION test_fixture.legacy_reader()" >/dev/null

"${admin_psql[@]}" >/dev/null < "$contract"
"${admin_psql[@]}" >/dev/null < "$contract"

"${admin_psql[@]}" <<'SQL'
\set QUIET on
SELECT * FROM app_core.update_instruction_slot_preferences(test_fixture.uid('1013'), NULL, false, NULL) \g /dev/null
SELECT app_core.update_reply_style_preferences(test_fixture.uid('1013'), '{"style-c": true}') \g /dev/null
SELECT app_core.update_reply_style_preferences(test_fixture.uid('1013'), '{"style-d": false}') \g /dev/null
DO $after_contract$
DECLARE
  v jsonb;
BEGIN
  IF to_regclass('app_core.miniapp_user_settings') IS NOT NULL
     OR (SELECT relkind FROM pg_class WHERE oid = 'app_core.user_preferences'::regclass) <> 'r'
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'app_core' AND table_name = 'user_preferences'
                AND column_name IN ('tg_username', 'tg_first_name', 'tg_last_name', 'tg_avatar_url', 'display_name', 'custom_avatar_url', 'avatar_url'))
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname LIKE 'miniapp_user_settings%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_preferences_pkey')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_preferences_user_id_fkey')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'app_core.user_preferences'::regclass)
     OR NOT has_table_privilege('service_role', 'app_core.user_preferences', 'UPDATE')
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('settings_fill_profile', 'settings_sync_profile', 'users_sync_profile')) THEN
    RAISE EXCEPTION 'contract end state wrong';
  END IF;
  IF (SELECT display_name FROM app_core.users WHERE tg_id = '1012') <> 'RaceNick12' THEN
    RAISE EXCEPTION 'race leftover not reconciled';
  END IF;
  -- Preferences survived the rename; preference functions work on the renamed table.
  IF EXISTS (SELECT b.user_id FROM test_fixture.settings_before b JOIN app_core.user_preferences p USING (user_id)
             WHERE b.user_id NOT IN (test_fixture.uid('1010'), test_fixture.uid('1011'), test_fixture.uid('1013'))
               AND (p.selected_model_id, p.pref_word_count, p.pref_reply_styles, p.pref_show_options)
                   IS DISTINCT FROM (b.selected_model_id, b.pref_word_count, b.pref_reply_styles, b.pref_show_options)) THEN
    RAISE EXCEPTION 'preferences changed by rename';
  END IF;
  IF (SELECT pref_show_status FROM app_core.user_preferences WHERE user_id = test_fixture.uid('1013'))
     OR (SELECT pref_reply_styles FROM app_core.user_preferences WHERE user_id = test_fixture.uid('1013'))
          <> '{"style-c": true, "style-d": false}' THEN
    RAISE EXCEPTION 'preference RPCs broken after rename';
  END IF;
  v := experience.start_chat_history_turn_with_current_postprocess(gen_random_uuid(), 'x', 'm');
  RAISE EXCEPTION 'start turn should fail on FK for unknown user';
EXCEPTION
  WHEN foreign_key_violation THEN NULL;
END $after_contract$;
DO $start$
BEGIN
  IF experience.start_chat_history_turn_with_current_postprocess(test_fixture.uid('1014'), 'x', 'm') ->> 'choice_rules_mode' <> 'full'
     OR experience.start_chat_history_regeneration_with_current_postprocess(test_fixture.uid('1011'), 1, 'm') ->> 'choice_rules_mode' <> 'off'
     OR experience.start_chat_history_turn_with_current_postprocess(test_fixture.uid('1036'), 'x', 'm') IS NULL
     OR (SELECT prosrc FROM pg_proc WHERE proname = 'start_chat_history_turn_with_current_postprocess') ~ 'miniapp_user_settings' THEN
    RAISE EXCEPTION 'start-turn functions broken after rename';
  END IF;
  -- Readers still return what they returned right before the contract (plus the reconciled race value).
  -- Only the reconciled race row (1012) may differ from what readers saw right before the contract.
  IF EXISTS (SELECT 1 FROM (SELECT * FROM cs_feed.user_identities EXCEPT SELECT * FROM test_fixture.identities_mid) d
             WHERE d.user_id <> test_fixture.uid('1012'))
     OR EXISTS (SELECT 1 FROM (SELECT * FROM test_fixture.identities_mid EXCEPT SELECT * FROM cs_feed.user_identities) d
                WHERE d.user_id <> test_fixture.uid('1012'))
     OR (SELECT display_name FROM cs_feed.user_identities WHERE user_id = test_fixture.uid('1012')) <> 'RaceNick12' THEN
    RAISE EXCEPTION 'user_identities changed by contract';
  END IF;
  IF app_core.refresh_user_profile(test_fixture.uid('1015'), 'u15', 'F15', NULL, NULL) ->> 'tg_first_name' <> 'F15' THEN
    RAISE EXCEPTION 'refresh_user_profile broken after contract';
  END IF;
END $start$;
SQL
echo 'OK: 20261117_db_reorg_p3b2_user_profile.sql + _contract'
