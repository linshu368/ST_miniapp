#!/usr/bin/env bash
set -euo pipefail

# Local-only regression for 20261013_admin_platform_instruction_slots.sql.
# It recreates the existing specialized text-postprocess history rows that
# must remain valid while the generic Admin allowlist stays closed.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
postgres_bin="${POSTGRES_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
for binary in initdb pg_ctl psql; do
  if [[ ! -x "$postgres_bin/$binary" ]]; then
    printf 'missing PostgreSQL 15+ binary: %s\n' "$postgres_bin/$binary" >&2
    exit 1
  fi
done

temp_root="$(mktemp -d /private/tmp/admin-platform-instruction-slots.XXXXXX)"
data_dir="$temp_root/data"
socket_dir="$temp_root/socket"
port=55433
cleanup() {
  if [[ -f "$data_dir/postmaster.pid" ]]; then "$postgres_bin/pg_ctl" -D "$data_dir" -m fast stop >/dev/null 2>&1 || true; fi
  rm -rf "$temp_root"
}
trap cleanup EXIT
mkdir -p "$socket_dir"
"$postgres_bin/initdb" -D "$data_dir" --username=postgres --no-locale --encoding=UTF8 --auth=trust >/dev/null
"$postgres_bin/pg_ctl" -D "$data_dir" -o "-k $socket_dir -p $port" -w start >/dev/null
psql_base=("$postgres_bin/psql" --no-psqlrc --set ON_ERROR_STOP=1 -h "$socket_dir" -p "$port" -U postgres -d postgres)

"${psql_base[@]}" <<'SQL' >/dev/null
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA admin;
CREATE SCHEMA app_core;

CREATE TABLE admin.config_drafts (
  id integer PRIMARY KEY,
  environment text NOT NULL,
  config_key text NOT NULL,
  value jsonb,
  text_value text,
  CONSTRAINT config_drafts_config_key_check CHECK (
    config_key IN ('system_instructions', 'miniapp_text_postprocess_config')
  )
);
CREATE TABLE admin.config_releases (
  id integer PRIMARY KEY,
  environment text NOT NULL,
  config_key text NOT NULL,
  runtime_version integer NOT NULL,
  value jsonb,
  text_value text,
  CONSTRAINT config_releases_config_key_check CHECK (
    config_key IN ('system_instructions', 'miniapp_text_postprocess_config')
  )
);
CREATE TABLE app_core.runtime_config (
  key text PRIMARY KEY,
  value jsonb,
  description text,
  version integer,
  updated_at timestamptz,
  text_value text
);

CREATE FUNCTION admin.is_managed_config_key(p_config_key text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $$ SELECT p_config_key = 'system_instructions' $$;
CREATE FUNCTION admin.validate_managed_config_value_before_rich_reply_protocol(
  p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$ BEGIN RETURN; END $$;
CREATE FUNCTION admin.validate_managed_config_value(
  p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$ BEGIN RETURN; END $$;

INSERT INTO admin.config_drafts (id, environment, config_key, value)
SELECT n, 'test', 'miniapp_text_postprocess_config', '{}'::jsonb
FROM generate_series(1, 8) AS series(n);
INSERT INTO admin.config_releases (id, environment, config_key, runtime_version, value)
SELECT n, 'test', 'miniapp_text_postprocess_config', n, '{}'::jsonb
FROM generate_series(1, 8) AS series(n);
SQL

"${psql_base[@]}" -f "$repo_root/packages/shared/migrations/20261013_admin_platform_instruction_slots.sql" >/dev/null
"${psql_base[@]}" <<'SQL' >/dev/null
DO $$
BEGIN
  IF (SELECT count(*) FROM admin.config_drafts WHERE config_key = 'miniapp_text_postprocess_config') <> 8
     OR (SELECT count(*) FROM admin.config_releases WHERE config_key = 'miniapp_text_postprocess_config') <> 8
     OR admin.is_managed_config_key('miniapp_text_postprocess_config') THEN
    RAISE EXCEPTION 'text-postprocess history or generic allowlist changed unexpectedly';
  END IF;

  INSERT INTO admin.config_drafts (id, environment, config_key, value)
  VALUES (9, 'test', 'miniapp_text_postprocess_config', '{}'::jsonb);
  INSERT INTO admin.config_releases (id, environment, config_key, runtime_version, value)
  VALUES (9, 'test', 'miniapp_text_postprocess_config', 9, '{}'::jsonb);

  BEGIN
    INSERT INTO admin.config_drafts (id, environment, config_key, value)
    VALUES (10, 'test', 'unmanaged_key', '{}'::jsonb);
    RAISE EXCEPTION 'unmanaged draft key was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO admin.config_releases (id, environment, config_key, runtime_version, value)
    VALUES (10, 'test', 'unmanaged_key', 10, '{}'::jsonb);
    RAISE EXCEPTION 'unmanaged release key was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$$;
SQL

printf 'PASS: local admin platform-instruction-slots migration regression\n'
