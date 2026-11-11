#!/usr/bin/env bash
# Disposable PostgreSQL 17 via local Unix socket only. No remote credentials or environment files.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
pgbin="${MUJIAN_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
tmp="$(mktemp -d /tmp/mujian-pg.XXXXXX)"
cleanup() { "$pgbin/pg_ctl" -D "$tmp/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT
"$pgbin/initdb" -D "$tmp/data" --auth=trust --no-locale >/dev/null
"$pgbin/pg_ctl" -D "$tmp/data" -l "$tmp/server.log" -o "-c listen_addresses='' -k $tmp -p 55439" -w start >/dev/null
psql=("$pgbin/psql" -X -h "$tmp" -p 55439 -d postgres -v ON_ERROR_STOP=1)
"${psql[@]}" -f "$root/scripts/mujian-entry-fixture.sql" >/dev/null
"${psql[@]}" -f "$root/packages/shared/migrations/20261111_mujian_entry_funnel.sql" >/dev/null
"${psql[@]}" -f "$root/packages/shared/migrations/tests/20261111_mujian_entry_funnel.sql"
"${psql[@]}" -f "$root/scripts/mujian-entry-assertions.sql"

# Concurrent retries share one identity, one fact and one first-source increment.
for attempt in 1 2 3 4; do
  "${psql[@]}" -c "SET ROLE service_role; SELECT miniapp_traffic.record_app_entry('10011','mujian','mujian_dzmm',date_trunc('second',now())-interval '1 hour');" >"$tmp/retry-$attempt.log" &
done
wait
"${psql[@]}" <<'SQL'
DO $$ BEGIN
 IF (SELECT count(*) FROM app_core.users WHERE tg_id='10011')<>1 OR
    (SELECT count(*) FROM miniapp_traffic.app_entry_facts WHERE user_id=(SELECT id FROM app_core.users WHERE tg_id='10011'))<>1
 THEN RAISE EXCEPTION 'concurrent duplication'; END IF;
END $$;
SQL
