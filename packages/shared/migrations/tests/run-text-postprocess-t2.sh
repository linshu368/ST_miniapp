#!/usr/bin/env bash
# Local-only scenarios for the text-postprocess migrations.
# Creates and drops a temporary database. Never point this at TEST or Production.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
MIG="$ROOT/packages/shared/migrations"
DB="text_postprocess_t2_$$"
KEEP=0
LEGACY_DB="${DB}_legacy"
if [[ -n "${PGSERVICE:-}" || -n "${PGSERVICEFILE:-}" || -n "${PGDATABASE:-}" || "${PGHOST:-/tmp}" != /* ]]; then
  echo "local-only runner requires an explicit Unix socket and no service/database override" >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1 || ! command -v createdb >/dev/null 2>&1; then
  echo "psql and createdb are required" >&2
  exit 1
fi

cleanup() {
  if [[ "$KEEP" -eq 0 ]]; then
    dropdb --if-exists "$DB" >/dev/null 2>&1 || true
    dropdb --if-exists "$LEGACY_DB" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

createdb "$DB"

run_sql() {
  psql -v ON_ERROR_STOP=1 -q -d "$DB" "$@"
}

run_sql -f "$MIG/fixtures/text_postprocess_t2_harness.sql"
run_sql -f "$MIG/20260928_text_postprocess_versions.sql"
run_sql -f "$MIG/20260928_chat_history_postprocess_version.sql"
run_sql -f "$MIG/20260928_text_postprocess_versions.sql"
run_sql -f "$MIG/20260928_chat_history_postprocess_version.sql"
run_sql -f "$MIG/tests/text_postprocess_t2_scenarios.sql"
run_sql -c "SELECT text_postprocess_t2.run();"

# Two sessions: the first holds the config advisory lock, the second must time out.
LOCK_SQL=$(cat <<'SQL'
BEGIN;
SELECT admin.save_text_postprocess_draft(
  '00000000-0000-4000-8000-0000000000a1',
  '00000000-0000-4000-8000-000000000109',
  repeat('61', 32),
  2,
  NULL,
  NULL,
  repeat('ef', 32),
  '{"schema_version":1,"policy_version":1,"rules":[]}'::jsonb
);
SELECT pg_sleep(8);
ROLLBACK;
SQL
)

psql -q -d "$DB" -c "$LOCK_SQL" &
LOCK_PID=$!
sleep 2

set +e
WAIT_OUTPUT=$(psql -v ON_ERROR_STOP=1 -d "$DB" -c "SET lock_timeout = '2s'; SELECT admin.save_text_postprocess_draft(
  '00000000-0000-4000-8000-0000000000a1',
  '00000000-0000-4000-8000-00000000010a',
  repeat('62', 32),
  2, NULL, NULL, repeat('cd', 32),
  '{\"schema_version\":1,\"policy_version\":1,\"rules\":[]}'::jsonb
);" 2>&1)
WAIT_STATUS=$?
set -e

case "$WAIT_STATUS:$WAIT_OUTPUT" in
  0:*)
    echo "concurrency check failed: second save did not wait" >&2
    echo "$WAIT_OUTPUT" >&2
    wait "$LOCK_PID" || true
    exit 1
    ;;
  *55P03*|*lock_timeout*|*canceling\ statement\ due\ to\ lock\ timeout*)
    ;;
  *)
    echo "concurrency check failed: expected lock_timeout, got status $WAIT_STATUS" >&2
    echo "$WAIT_OUTPUT" >&2
    wait "$LOCK_PID" || true
    exit 1
    ;;
esac

wait "$LOCK_PID"
run_sql -c "SELECT admin.get_text_postprocess_request(
  '00000000-0000-4000-8000-0000000000a1',
  '00000000-0000-4000-8000-000000000109'
) IS NULL AS request_unknown;"

# Early local draft: table exists without artifact; legacy row stays NULL, old overloads disappear.
createdb "$LEGACY_DB"
psql -v ON_ERROR_STOP=1 -q -d "$LEGACY_DB" -f "$MIG/fixtures/text_postprocess_t2_harness.sql"
psql -v ON_ERROR_STOP=1 -q -d "$LEGACY_DB" <<'SQL'
CREATE TABLE app_core.text_postprocess_versions (
  version integer PRIMARY KEY, source jsonb NOT NULL, schema_version integer NOT NULL,
  policy_version integer NOT NULL, published_at timestamptz NOT NULL
);
INSERT INTO app_core.text_postprocess_versions VALUES (7,'{"schema_version":1,"policy_version":1,"rules":[]}',1,1,now());
CREATE FUNCTION admin.publish_text_postprocess(uuid,uuid,text,integer,timestamptz,text,text) RETURNS jsonb LANGUAGE sql AS 'SELECT ''{}''::jsonb';
CREATE FUNCTION admin.rollback_text_postprocess(uuid,uuid,text,integer,integer) RETURNS jsonb LANGUAGE sql AS 'SELECT ''{}''::jsonb';
SQL
psql -v ON_ERROR_STOP=1 -q -d "$LEGACY_DB" -f "$MIG/20260928_text_postprocess_versions.sql"
psql -v ON_ERROR_STOP=1 -q -d "$LEGACY_DB" -f "$MIG/20260928_text_postprocess_versions.sql"
psql -v ON_ERROR_STOP=1 -q -d "$LEGACY_DB" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_core.text_postprocess_versions WHERE version=7 AND artifact IS NULL)
    OR to_regprocedure('admin.publish_text_postprocess(uuid,uuid,text,integer,timestamptz,text,text)') IS NOT NULL
    OR to_regprocedure('admin.rollback_text_postprocess(uuid,uuid,text,integer,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy recovery failed';
  END IF;
  PERFORM admin.text_postprocess_writer_enter();
  BEGIN
    INSERT INTO app_core.text_postprocess_versions VALUES (8,'{"schema_version":1,"policy_version":1,"rules":[]}',1,1,now(),NULL);
    RAISE EXCEPTION 'new NULL artifact accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
-- Drift in an already-patched generic function must stop the entire migration.
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef('admin.publish_config_draft(uuid)'::regprocedure) INTO v_def;
  EXECUTE replace(v_def,
    'PERFORM admin.reject_generic_text_postprocess_write(v_draft.config_key);',
    'PERFORM admin.reject_generic_text_postprocess_write(''system_instructions'');');
END $$;
SQL
if psql -v ON_ERROR_STOP=1 -q -d "$LEGACY_DB" -f "$MIG/20260928_text_postprocess_versions.sql" > /dev/null 2>&1; then
  echo "drift did not fail closed" >&2
  exit 1
fi
# Restore local prerequisite functions and verify forward recovery without deleting old rows.
psql -v ON_ERROR_STOP=1 -q -d "$LEGACY_DB" -f "$MIG/fixtures/text_postprocess_t2_harness.sql"
psql -v ON_ERROR_STOP=1 -q -d "$LEGACY_DB" -f "$MIG/20260928_text_postprocess_versions.sql"

echo "text_postprocess_t2 ok"
