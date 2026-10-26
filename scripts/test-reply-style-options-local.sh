#!/usr/bin/env bash
set -euo pipefail
# Disposable synthetic database only. No DATABASE_URL or remote connection path.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
postgres_bin="${POSTGRES_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
for binary in initdb pg_ctl psql; do
  if [[ ! -x "$postgres_bin/$binary" ]]; then
    printf 'missing PostgreSQL 15+ binary: %s\n' "$postgres_bin/$binary" >&2
    exit 1
  fi
done
temp_root="$(mktemp -d "${TMPDIR:-/private/tmp}/reply-style-options.XXXXXX")"
data_dir="$temp_root/data"
socket_dir="$temp_root/socket"
cleanup() {
  if [[ -f "$data_dir/postmaster.pid" ]]; then "$postgres_bin/pg_ctl" -D "$data_dir" -m fast stop >/dev/null 2>&1 || true; fi
  rm -rf "$temp_root"
}
trap cleanup EXIT
mkdir -p "$socket_dir"
"$postgres_bin/initdb" -D "$data_dir" --username=postgres --no-locale --encoding=UTF8 --auth=trust >/dev/null
"$postgres_bin/pg_ctl" -D "$data_dir" -o "-k $socket_dir -p 55436 -c listen_addresses=''" -w start >/dev/null
psql_base=("$postgres_bin/psql" --no-psqlrc --set ON_ERROR_STOP=1 -h "$socket_dir" -p 55436 -U postgres -d postgres)
"${psql_base[@]}" <<'SQL' >/dev/null
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE existing_config_auditor NOLOGIN;
CREATE SCHEMA app_core;
CREATE SCHEMA admin;
GRANT USAGE ON SCHEMA app_core TO service_role;
CREATE TABLE app_core.users(id uuid PRIMARY KEY);
INSERT INTO app_core.users VALUES
 ('10000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002'),
 ('10000000-0000-0000-0000-000000000003');
CREATE TABLE app_core.miniapp_user_settings (
 user_id uuid PRIMARY KEY REFERENCES app_core.users(id),
 pref_custom_instructions text,
 pref_word_count text,
 pref_show_options boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_core.miniapp_user_settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON app_core.miniapp_user_settings TO service_role;
INSERT INTO app_core.miniapp_user_settings(user_id,pref_custom_instructions,pref_word_count)
VALUES ('10000000-0000-0000-0000-000000000001','保留个人偏好','300-500');
CREATE TABLE app_core.runtime_config (
 key text PRIMARY KEY,value jsonb,text_value text,description text,version integer,updated_at timestamptz
);
CREATE FUNCTION admin.is_managed_config_key(p_config_key text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog
AS $$ SELECT p_config_key IN ('system_instructions','future_existing_key','image_plaza_tags') $$;
CREATE FUNCTION admin.validate_managed_config_value(p_config_key text,p_value jsonb,p_text_value text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ BEGIN
 IF p_config_key='future_existing_key' AND p_value='true'::jsonb AND p_text_value IS NULL THEN RETURN; END IF;
 RAISE EXCEPTION 'prior validator rejected' USING ERRCODE='22023';
END $$;
REVOKE ALL ON FUNCTION admin.is_managed_config_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.is_managed_config_key(text) TO existing_config_auditor WITH GRANT OPTION;
GRANT EXECUTE ON FUNCTION admin.validate_managed_config_value(text,jsonb,text) TO existing_config_auditor;
CREATE TABLE admin.config_drafts (
 id integer PRIMARY KEY,environment text NOT NULL,config_key text NOT NULL,value jsonb,text_value text,
 CONSTRAINT config_drafts_config_key_check CHECK (
 admin.is_managed_config_key(config_key) OR config_key IN ('miniapp_text_postprocess_config','legacy_history_only'))
);
CREATE TABLE admin.config_releases (
 id integer PRIMARY KEY,environment text NOT NULL,config_key text NOT NULL,runtime_version integer NOT NULL,value jsonb,text_value text
);
ALTER TABLE admin.config_releases ADD CONSTRAINT config_releases_config_key_check CHECK (
 admin.is_managed_config_key(config_key) OR config_key IN ('miniapp_text_postprocess_config','legacy_history_only')) NOT VALID;
INSERT INTO admin.config_drafts VALUES (1,'test','future_existing_key','true'::jsonb,NULL),(2,'test','legacy_history_only','{}',NULL);
INSERT INTO admin.config_releases VALUES (1,'test','future_existing_key',1,'true'::jsonb,NULL),(2,'test','legacy_history_only',2,'{}',NULL);
SQL
"${psql_base[@]}" -f "$repo_root/packages/shared/migrations/20261023_reply_style_options.sql" >/dev/null
"${psql_base[@]}" <<'SQL' >/dev/null
CREATE FUNCTION pg_temp.reject_config(p_value jsonb,p_text text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 BEGIN
  PERFORM admin.validate_managed_config_value('reply_style_options',p_value,p_text);
 EXCEPTION WHEN SQLSTATE '22023' THEN RETURN; END;
 RAISE EXCEPTION 'invalid catalog accepted';
END $$;
DO $$
DECLARE v_table regclass; v_expr text; v_allowed boolean; v_option jsonb; v_bad jsonb;
BEGIN
 IF (SELECT pref_reply_styles FROM app_core.miniapp_user_settings WHERE user_id='10000000-0000-0000-0000-000000000001') <> '{}'::jsonb
 OR (SELECT pref_custom_instructions FROM app_core.miniapp_user_settings WHERE user_id='10000000-0000-0000-0000-000000000001') <> '保留个人偏好' THEN
  RAISE EXCEPTION 'existing settings changed or new default missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app_core.runtime_config WHERE key='reply_style_options' AND value='{"options":[]}'::jsonb AND text_value IS NULL) THEN
  RAISE EXCEPTION 'empty catalog seed missing'; END IF;
 v_option := jsonb_build_object('id','style-a','name','示例','description','','marker','','rules','','enabled',true);
 PERFORM admin.validate_managed_config_value('reply_style_options',jsonb_build_object('options',jsonb_build_array(v_option)),NULL);
 PERFORM admin.validate_managed_config_value('reply_style_options','{"options":[]}',NULL);
 PERFORM pg_temp.reject_config(NULL);
 PERFORM pg_temp.reject_config('[]');
 PERFORM pg_temp.reject_config('{"options":[]}','not-json');
 PERFORM pg_temp.reject_config('{"options":[],"extra":true}');
 PERFORM pg_temp.reject_config('{"options":[null]}');
 PERFORM pg_temp.reject_config(jsonb_build_object('options',jsonb_build_array(v_option,v_option)));
 FOR v_bad IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
  '{"name":""}'::jsonb,jsonb_build_object('name',U&'\FEFF'),jsonb_build_object('name',U&'\00A0'),'{"id":"constructor"}'::jsonb,'{"enabled":"true"}'::jsonb,
  '{"extra":1}'::jsonb,jsonb_build_object('name',repeat('a',41)),
  jsonb_build_object('description',repeat('a',201)),jsonb_build_object('marker',repeat('a',121)),
  jsonb_build_object('rules',repeat('a',12001)),jsonb_build_object('name',repeat('😀',21))
 )) LOOP
  PERFORM pg_temp.reject_config(jsonb_build_object('options',jsonb_build_array(v_option||v_bad)));
 END LOOP;
 PERFORM admin.validate_managed_config_value('reply_style_options',jsonb_build_object('options',jsonb_build_array(v_option||jsonb_build_object('name',repeat('😀',20)))),NULL);
 PERFORM pg_temp.reject_config(jsonb_build_object('options',jsonb_build_array(v_option||'{"marker":" SAME "}',v_option||'{"id":"style-b","marker":"SAME"}')));
 PERFORM pg_temp.reject_config(jsonb_build_object('options',(SELECT jsonb_agg(v_option||jsonb_build_object('id','style-'||n)) FROM generate_series(1,25)n)));
 PERFORM pg_temp.reject_config(jsonb_build_object('options',jsonb_build_array(v_option||jsonb_build_object('marker',U&'\FEFFSAME'),v_option||'{"id":"style-b","marker":"SAME"}')));
 PERFORM admin.validate_managed_config_value('future_existing_key','true',NULL);
 BEGIN
  PERFORM admin.validate_managed_config_value('future_existing_key','false',NULL);
  RAISE EXCEPTION 'old validator bypassed';
 EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
 IF admin.is_managed_config_key('image_plaza_tags') IS DISTINCT FROM true
 OR admin.is_managed_config_key('future_existing_key') IS DISTINCT FROM true
 OR admin.is_managed_config_key('miniapp_text_postprocess_config') IS DISTINCT FROM false
 OR admin.is_managed_config_key('__unknown__') IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'old allowlist behavior changed'; END IF;
 FOREACH v_table IN ARRAY ARRAY['admin.config_drafts'::regclass,'admin.config_releases'::regclass] LOOP
  SELECT pg_get_expr(c.conbin,c.conrelid) INTO v_expr FROM pg_constraint c WHERE c.conrelid=v_table AND c.conname IN ('config_drafts_config_key_check','config_releases_config_key_check');
  EXECUTE format('SELECT (%s) FROM (SELECT $1::text AS config_key)x',v_expr) INTO v_allowed USING 'reply_style_options';
  IF v_allowed IS DISTINCT FROM true THEN RAISE EXCEPTION 'new key rejected by check'; END IF;
  EXECUTE format('SELECT (%s) FROM (SELECT $1::text AS config_key)x',v_expr) INTO v_allowed USING 'legacy_history_only';
  IF v_allowed IS DISTINCT FROM true THEN RAISE EXCEPTION 'old history exception lost'; END IF;
  EXECUTE format('SELECT (%s) FROM (SELECT $1::text AS config_key)x',v_expr) INTO v_allowed USING '__unknown__';
  IF v_allowed IS DISTINCT FROM false THEN RAISE EXCEPTION 'unknown key accepted'; END IF;
 END LOOP;
 IF NOT(SELECT convalidated FROM pg_constraint WHERE conrelid='admin.config_drafts'::regclass AND conname='config_drafts_config_key_check')
 OR (SELECT convalidated FROM pg_constraint WHERE conrelid='admin.config_releases'::regclass AND conname='config_releases_config_key_check') THEN
  RAISE EXCEPTION 'CHECK validation states changed'; END IF;
 IF NOT has_function_privilege('existing_config_auditor','admin.is_managed_config_key(text)','EXECUTE WITH GRANT OPTION')
 OR NOT has_function_privilege('existing_config_auditor','admin.validate_managed_config_value(text,jsonb,text)','EXECUTE')
 OR has_function_privilege('anon','admin.is_managed_config_key(text)','EXECUTE')
 OR has_function_privilege('authenticated','app_core.update_reply_style_preferences(uuid,jsonb)','EXECUTE')
 OR has_function_privilege('anon','app_core.update_reply_style_preferences(uuid,jsonb)','EXECUTE')
 OR NOT has_function_privilege('service_role','app_core.update_reply_style_preferences(uuid,jsonb)','EXECUTE')
 OR EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_core.update_reply_style_preferences(uuid,jsonb)'::regprocedure AND prosecdef) THEN
  RAISE EXCEPTION 'function ACL/security shape changed'; END IF;
END $$;
SET ROLE service_role;
SELECT app_core.update_reply_style_preferences('10000000-0000-0000-0000-000000000001','{"style-a":true}');
SELECT app_core.update_reply_style_preferences('10000000-0000-0000-0000-000000000001','{"style-b":true,"style-a":false}');
SELECT app_core.update_reply_style_preferences('10000000-0000-0000-0000-000000000002','{"style-new":true}');
RESET ROLE;
DO $$ BEGIN
 IF (SELECT pref_reply_styles FROM app_core.miniapp_user_settings WHERE user_id='10000000-0000-0000-0000-000000000001') <> '{"style-a":false,"style-b":true}'::jsonb THEN RAISE EXCEPTION 'partial merge overwrote other keys'; END IF;
 IF (SELECT pref_custom_instructions FROM app_core.miniapp_user_settings WHERE user_id='10000000-0000-0000-0000-000000000001') <> '保留个人偏好' THEN RAISE EXCEPTION 'merge changed unrelated field'; END IF;
 BEGIN PERFORM app_core.update_reply_style_preferences('10000000-0000-0000-0000-000000000001','{"style-a":"true"}'); RAISE EXCEPTION 'nonboolean patch accepted'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
 BEGIN PERFORM app_core.update_reply_style_preferences('10000000-0000-0000-0000-000000000001','[]'); RAISE EXCEPTION 'nonobject patch accepted'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
 BEGIN PERFORM app_core.update_reply_style_preferences(NULL,'{}'); RAISE EXCEPTION 'null user accepted'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
 PERFORM app_core.update_reply_style_preferences('10000000-0000-0000-0000-000000000003',(SELECT jsonb_object_agg('style-'||n,true) FROM generate_series(1,64)n));
 BEGIN PERFORM app_core.update_reply_style_preferences('10000000-0000-0000-0000-000000000003','{"style-overflow":true}'); RAISE EXCEPTION 'merged overflow accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
 IF (SELECT count(*) FROM jsonb_object_keys((SELECT pref_reply_styles FROM app_core.miniapp_user_settings WHERE user_id='10000000-0000-0000-0000-000000000003'))) <> 64 THEN RAISE EXCEPTION 'failed merge corrupted prior value'; END IF;
END $$;
INSERT INTO admin.config_drafts VALUES (3,'test','reply_style_options','{"options":[]}',NULL);
INSERT INTO admin.config_releases VALUES (3,'test','reply_style_options',3,'{"options":[]}',NULL);
UPDATE app_core.runtime_config SET value='{"options":[{"id":"style-custom","name":"自定义","description":"","marker":"","rules":"","enabled":true}]}'::jsonb WHERE key='reply_style_options';
SQL
# Independent option writes against one user must merge under row lock.
for suffix in 1 2 3 4 5 6 7 8; do
  "${psql_base[@]}" -c "SET ROLE service_role; SELECT app_core.update_reply_style_preferences('10000000-0000-0000-0000-000000000002',jsonb_build_object('style-concurrent-$suffix',true));" >"$temp_root/write-$suffix.log" &
done
wait
"${psql_base[@]}" -f "$repo_root/packages/shared/migrations/20261023_reply_style_options.sql" >/dev/null
"${psql_base[@]}" <<'SQL' >/dev/null
DO $$ BEGIN
 IF (SELECT count(*) FROM jsonb_object_keys((SELECT pref_reply_styles FROM app_core.miniapp_user_settings WHERE user_id='10000000-0000-0000-0000-000000000002'))) <> 9 THEN RAISE EXCEPTION 'concurrent updates lost keys'; END IF;
 IF (SELECT value->'options'->0->>'name' FROM app_core.runtime_config WHERE key='reply_style_options') <> '自定义' THEN RAISE EXCEPTION 'replay overwrote operator catalog'; END IF;
 IF (SELECT pref_reply_styles->'style-a' FROM app_core.miniapp_user_settings WHERE user_id='10000000-0000-0000-0000-000000000001') <> 'false'::jsonb THEN RAISE EXCEPTION 'replay changed user choice'; END IF;
END $$;
SQL
printf 'PASS: reply style metadata, defaults, privacy boundaries, validator, ACL, atomic concurrent merge and replay\n'
