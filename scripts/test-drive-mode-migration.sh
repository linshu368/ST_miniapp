#!/usr/bin/env bash
# Drive mode migration on disposable PG17. No remote URI, user data, model or billing calls.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="drive-mode-pg-$$"
cleanup() { docker rm -f "$task_container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] && docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
task_psql=(docker exec -i "$task_container" psql -X -U postgres -v ON_ERROR_STOP=1)

# Stubs shaped like the real objects this migration reads or wraps.
"${task_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA app_core;
CREATE SCHEMA admin;
CREATE TABLE app_core.miniapp_user_settings(user_id uuid PRIMARY KEY, pref_word_count text);
INSERT INTO app_core.miniapp_user_settings(user_id) VALUES ('11111111-1111-4111-8111-111111111111');
CREATE FUNCTION admin.is_managed_config_key(p_config_key text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT p_config_key IN ('system_instructions') $$;
CREATE FUNCTION admin.validate_managed_config_value(p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql STABLE AS $$ BEGIN
  IF NOT admin.is_managed_config_key(p_config_key) THEN RAISE EXCEPTION 'unknown managed key %', p_config_key; END IF;
END $$;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.validate_managed_config_value(text,jsonb,text) TO service_role;
CREATE TABLE admin.config_drafts(config_key text NOT NULL,
  CONSTRAINT config_drafts_config_key_check CHECK (config_key IN ('system_instructions')));
CREATE TABLE admin.config_releases(config_key text NOT NULL,
  CONSTRAINT config_releases_config_key_check CHECK (config_key IN ('system_instructions')));
SQL

# Apply twice: a retried workflow run must be a no-op, not a second wrapper.
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/20261117_drive_mode.sql" >/dev/null
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/20261117_drive_mode.sql" >/dev/null

"${task_psql[@]}" >/dev/null <<'SQL'
DO $assert$
DECLARE v_failed boolean;
BEGIN
  -- managed key chain keeps the predecessor and still rejects unknown keys
  ASSERT admin.is_managed_config_key('drive_mode_options');
  ASSERT admin.is_managed_config_key('system_instructions');
  ASSERT NOT admin.is_managed_config_key('__nope__');
  PERFORM admin.validate_managed_config_value('drive_mode_options',
    '{"modes":[{"id":"active"}],"default_mode_id":"active"}'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value('system_instructions', NULL, 'template');
  FOR v_failed IN SELECT unnest(ARRAY[true]) LOOP
    BEGIN
      PERFORM admin.validate_managed_config_value('drive_mode_options', '{"modes":{}}'::jsonb, NULL);
      RAISE EXCEPTION 'non-array modes accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
    BEGIN
      PERFORM admin.validate_managed_config_value('drive_mode_options', '{"modes":[]}'::jsonb, 'text');
      RAISE EXCEPTION 'text value accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
    BEGIN
      PERFORM admin.validate_managed_config_value('__nope__', '{}'::jsonb, NULL);
      RAISE EXCEPTION 'unknown key accepted';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM = 'unknown key accepted' THEN RAISE; END IF;
    END;
  END LOOP;
  -- only one wrapper generation exists after the second run
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname LIKE 'is_managed_config_key_before_drive_mode%') = 1;
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname = 'validate_managed_config_value_before_drive_mode') = 1;
  -- EXECUTE privileges copied from the predecessor, not widened to PUBLIC
  ASSERT has_function_privilege('service_role', 'admin.validate_managed_config_value(text,jsonb,text)', 'EXECUTE');
  ASSERT NOT has_function_privilege('anon', 'admin.validate_managed_config_value(text,jsonb,text)', 'EXECUTE');

  -- draft/release tables accept the new key and still reject unknown keys
  INSERT INTO admin.config_drafts(config_key) VALUES ('drive_mode_options');
  INSERT INTO admin.config_releases(config_key) VALUES ('drive_mode_options');
  BEGIN
    INSERT INTO admin.config_drafts(config_key) VALUES ('__nope__');
    RAISE EXCEPTION 'unknown draft key accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- preference column: existing rows stay NULL, valid ids accepted, malformed ids rejected
  ASSERT (SELECT pref_drive_mode IS NULL FROM app_core.miniapp_user_settings
          WHERE user_id = '11111111-1111-4111-8111-111111111111');
  UPDATE app_core.miniapp_user_settings SET pref_drive_mode = 'active';
  UPDATE app_core.miniapp_user_settings SET pref_drive_mode = NULL;
  BEGIN
    UPDATE app_core.miniapp_user_settings SET pref_drive_mode = 'Active Mode';
    RAISE EXCEPTION 'malformed drive mode accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$assert$;
SQL
echo "OK: drive mode migration (applied twice, key chain, ACL, CHECKs)"
