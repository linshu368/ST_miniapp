#!/usr/bin/env bash
# Opt-in isolated PG17 + real PostgREST; no remote credentials or application env files.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_pg_bin="${OPENROUTER_TEST_PG_BIN:-$(pg_config --bindir)}"
task_rest_bin="${OPENROUTER_TEST_POSTGREST_BIN:?Set a local PostgREST executable path}"
task_dir="$(mktemp -d /tmp/openrouter-retirement.XXXXXX)"
task_rest_pid=''
cleanup() {
 if [[ -n "$task_rest_pid" ]]; then kill "$task_rest_pid" 2>/dev/null || true; fi
 "$task_pg_bin/pg_ctl" -D "$task_dir/data" -m fast -w stop >/dev/null 2>&1 || true
 case "$task_dir" in /tmp/openrouter-retirement.*) rm -rf -- "$task_dir" ;; esac
}
trap cleanup EXIT
# Ephemeral loopback ports; PostgREST and PG never bind public interfaces.
read -r task_pg_port task_rest_port < <(python3 - <<'PY'
import socket
sockets=[socket.socket(),socket.socket()]
for sock in sockets: sock.bind(('127.0.0.1',0))
print(*(sock.getsockname()[1] for sock in sockets))
for sock in sockets: sock.close()
PY
)
"$task_pg_bin/initdb" -D "$task_dir/data" -U postgres --auth=trust --encoding=UTF8 --locale=C >"$task_dir/init.log"
"$task_pg_bin/pg_ctl" -D "$task_dir/data" -l "$task_dir/pg.log" -o "-k $task_dir -p $task_pg_port -c listen_addresses=127.0.0.1" -w start >/dev/null
task_psql=("$task_pg_bin/psql" -X -h "$task_dir" -p "$task_pg_port" -U postgres -d postgres -v ON_ERROR_STOP=1)
task_sql="$task_root/packages/shared/migrations"
"${task_psql[@]}" -f "$task_root/scripts/openrouter-retirement-bootstrap.sql" >/dev/null
"${task_psql[@]}" -f "$task_sql/20260929_venice_chat_history.sql" >/dev/null
"${task_psql[@]}" -c "INSERT INTO experience.venice_chat_history(chat_history_id,llm_generation_id,llm_latency,llm_usage) VALUES('00000000-0000-0000-0000-000000000002','venice-fixture',7,'0'); GRANT SELECT ON experience.venice_chat_history TO cs_persona_reader;" >/dev/null
for task_file in 20261015_openrouter_chat_history.sql 20261015_openrouter_chat_history_backfill.sql 20261015_openrouter_chat_history_venice_exclusion_backfill.sql 20261016_openrouter_original_metadata_fields.sql; do
 "${task_psql[@]}" -f "$task_sql/$task_file" >/dev/null
done
# A valid missing historical identity, a proven no-ID scalar, and an unknown no-ID scalar.
"${task_psql[@]}" -c "DELETE FROM experience.openrouter_chat_history WHERE chat_history_id='00000000-0000-0000-0000-000000000001'; CREATE TABLE experience.view_shape AS SELECT attname,atttypid,atttypmod,attnum FROM pg_attribute WHERE attrelid='experience.current_chat_history'::regclass AND attnum>0;" >/dev/null
expect_reject() {
 if "${task_psql[@]}" -f "$task_sql/20261016_chat_history_drop_provider_metadata.sql" >"$task_dir/reject.log" 2>&1; then
  echo 'FAIL: premature DROP was accepted' >&2; exit 1
 fi
 rg -q "$1" "$task_dir/reject.log"
}
expect_reject 'Legacy column database dependency remains'
"${task_psql[@]}" -f "$task_sql/20261016_openrouter_retirement_catchup.sql" >/dev/null
"${task_psql[@]}" -f "$task_sql/20261016_chat_history_provider_metadata_views.sql" >/dev/null
expect_reject 'Unpreserved identity/scalars'
# Synthetic-only audit resolution: a fixture supplies reliable attribution, never done remotely.
"${task_psql[@]}" -c "UPDATE experience.chat_history SET llm_billing_snapshot='{\"provider\":\"openrouter\"}' WHERE id='00000000-0000-0000-0000-000000000004';" >/dev/null
"${task_psql[@]}" -f "$task_sql/20261016_openrouter_retirement_catchup.sql" >/dev/null
"${task_psql[@]}" -c "UPDATE experience.chat_history SET llm_generation_data='{\"prompt\":\"synthetic-only\"}' WHERE id='00000000-0000-0000-0000-000000000004';" >/dev/null
expect_reject 'Legacy diagnostic JSON requires'
"${task_psql[@]}" -c "UPDATE experience.chat_history SET llm_generation_data=NULL WHERE id='00000000-0000-0000-0000-000000000004';" >/dev/null
"${task_psql[@]}" -c "UPDATE experience.chat_history SET llm_charge_id='00000000-0000-0000-0000-000000000201' WHERE id='00000000-0000-0000-0000-000000000001';" >/dev/null
expect_reject 'Historical billing/quota closure not proven'
# Synthetic-only closure of the fixture's legacy accounting, without any real wallet.
"${task_psql[@]}" -c "UPDATE experience.chat_history SET llm_billing_settled_at=now() WHERE id='00000000-0000-0000-0000-000000000001'; INSERT INTO experience.chat_history(id,llm_charge_id) VALUES('00000000-0000-0000-0000-000000000050','00000000-0000-0000-0000-000000000250'); INSERT INTO experience.openrouter_chat_history(chat_history_id) VALUES('00000000-0000-0000-0000-000000000050');" >/dev/null
"${task_psql[@]}" -f "$task_sql/20261016_chat_history_drop_provider_metadata.sql" >/dev/null
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM experience.chat_history WHERE id='00000000-0000-0000-0000-000000000050' AND status='streaming' AND llm_charge_id IS NOT NULL) THEN RAISE EXCEPTION 'healthy active call was changed'; END IF;
END $$;
DELETE FROM experience.chat_history WHERE id='00000000-0000-0000-0000-000000000050';
DO $$ BEGIN
 IF EXISTS (SELECT * FROM experience.view_shape EXCEPT SELECT attname,atttypid,atttypmod,attnum FROM pg_attribute WHERE attrelid='experience.current_chat_history'::regclass AND attnum>0) THEN RAISE EXCEPTION 'view shape changed'; END IF;
 IF NOT (SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class WHERE oid='experience.current_chat_history'::regclass) THEN RAISE EXCEPTION 'invoker mode lost'; END IF;
 IF (SELECT count(*) FROM experience.current_chat_history)<>4 OR (SELECT count(*) FROM miniapp_analytics.base_chat_bj)<>4 THEN RAISE EXCEPTION 'view cardinality changed'; END IF;
 IF (SELECT llm_latency FROM miniapp_analytics.base_chat_bj WHERE id='00000000-0000-0000-0000-000000000002')<>7 THEN RAISE EXCEPTION 'Venice latency misrouted'; END IF;
 IF (SELECT llm_finish_reason FROM experience.current_chat_history WHERE id='00000000-0000-0000-0000-000000000001')<>'cancelled' THEN RAISE EXCEPTION 'business finish changed'; END IF;
 IF has_table_privilege('cs_persona_reader','experience.openrouter_chat_history','SELECT') THEN RAISE EXCEPTION 'reader was given entire table'; END IF;
 IF has_any_column_privilege('anon','experience.openrouter_chat_history','SELECT') OR has_any_column_privilege('authenticated','experience.openrouter_chat_history','SELECT') THEN RAISE EXCEPTION 'public metadata grant'; END IF;
END $$;
SET ROLE cs_persona_reader;
SELECT * FROM experience.current_chat_history;
SELECT * FROM miniapp_analytics.base_chat_bj;
RESET ROLE;
SQL
# Strip all inherited env: this process cannot see Railway keys, .env files, or remote DB URIs.
env -i PATH="$PATH" DYLD_LIBRARY_PATH="${OPENROUTER_TEST_LIBPQ_DIR:-/opt/homebrew/lib/postgresql@17}" \
 PGRST_DB_URI="postgresql://postgres@127.0.0.1:$task_pg_port/postgres" PGRST_DB_SCHEMAS=experience \
 PGRST_DB_ANON_ROLE=service_role PGRST_SERVER_HOST=127.0.0.1 PGRST_SERVER_PORT="$task_rest_port" \
 "$task_rest_bin" >"$task_dir/postgrest.log" 2>&1 &
task_rest_pid=$!
for task_attempt in {1..50}; do
 if curl -fsS "http://127.0.0.1:$task_rest_port/" >/dev/null 2>&1; then break; fi
 sleep 0.1
done
cd "$task_root"
env -i PATH="$PATH" HOME="$HOME" NODE_ENV=test DATABASE_ENV=test DOTENV_CONFIG_PATH=/dev/null \
 OPENROUTER_RETIREMENT_LOCAL_URL="http://127.0.0.1:$task_rest_port" \
 pnpm --filter @miniapp/backend exec tsx ../../scripts/openrouter-retirement-local.mts
# Replacing views also supports the TEST shape without the production-only role/view.
"${task_psql[@]}" -c 'DROP VIEW miniapp_analytics.base_chat_bj; DROP OWNED BY cs_persona_reader; DROP ROLE cs_persona_reader;' >/dev/null
"${task_psql[@]}" -f "$task_sql/20261016_chat_history_provider_metadata_views.sql" >/dev/null
expect_reject 'Expected exactly 12 legacy columns'
printf 'Retirement passed: real DROP, historical guards, provider views/ACL and real PostgREST repositories.\n'
