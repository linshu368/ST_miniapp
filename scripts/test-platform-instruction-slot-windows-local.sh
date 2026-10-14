#!/usr/bin/env bash
set -euo pipefail

# Creates a disposable PostgreSQL cluster reachable only via a Unix socket.
# This runner applies the original slot-window migration and its session-scoped
# forward-fix to a synthetic 20260930-compatible baseline. It has no DATABASE_URL
# inputs and must not be pointed at a remote DB.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
postgres_bin="${POSTGRES_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
for binary in initdb pg_ctl psql; do
  if [[ ! -x "$postgres_bin/$binary" ]]; then
    printf 'missing PostgreSQL 15+ binary: %s\n' "$postgres_bin/$binary" >&2
    exit 1
  fi
done
# macOS TMPDIR paths can exceed PostgreSQL's 103-byte Unix-socket limit.
temp_root="$(mktemp -d /private/tmp/platform-instruction-slots.XXXXXX)"
data_dir="$temp_root/data"
socket_dir="$temp_root/socket"
port=55432
cleanup() {
  if [[ -f "$data_dir/postmaster.pid" ]]; then "$postgres_bin/pg_ctl" -D "$data_dir" -m fast stop >/dev/null 2>&1 || true; fi
  rm -rf "$temp_root"
}
trap cleanup EXIT
mkdir -p "$socket_dir"
"$postgres_bin/initdb" -D "$data_dir" --username=postgres --no-locale --encoding=UTF8 --auth=trust >/dev/null
"$postgres_bin/pg_ctl" -D "$data_dir" -o "-k $socket_dir -p $port" -w start
psql_base=("$postgres_bin/psql" --no-psqlrc --set ON_ERROR_STOP=1 -h "$socket_dir" -p "$port" -U postgres -d postgres)
"${psql_base[@]}" -f "$repo_root/scripts/platform-instruction-slot-windows-bootstrap.sql" >/dev/null
"${psql_base[@]}" -f "$repo_root/packages/shared/migrations/20261013_platform_instruction_slot_windows.sql" >/dev/null
"${psql_base[@]}" -f "$repo_root/packages/shared/migrations/20261013_session_scoped_instruction_slot_modes.sql" >/dev/null
"${psql_base[@]}" -f "$repo_root/scripts/platform-instruction-slot-windows-assert.sql"

# Three concurrent starts in one session must still allocate distinct logical
# turns, with the first two full and the third concise.
for suffix in 1 2 3; do
  "${psql_base[@]}" -Atqc "SELECT experience.start_chat_history_turn_with_current_postprocess('10000000-0000-0000-0000-000000000003', '__concurrent__', 'local');" >"$temp_root/concurrent-$suffix.out" &
done
wait
"${psql_base[@]}" -v ON_ERROR_STOP=1 -c "DO \$\$ BEGIN
  IF (SELECT count(*) FROM experience.current_chat_history WHERE session_id = '10000000-0000-0000-0000-000000000003' AND choice_rules_mode = 'full') <> 2
     OR (SELECT count(*) FROM experience.current_chat_history WHERE session_id = '10000000-0000-0000-0000-000000000003' AND choice_rules_mode = 'concise') <> 1
     OR (SELECT choice_full_rules_remaining FROM app_core.miniapp_user_settings WHERE user_id = '10000000-0000-0000-0000-000000000003') <> 2 THEN
    RAISE EXCEPTION 'assertion failed: concurrent turns use session index without consuming user counters';
  END IF;
END \$\$;" >/dev/null
printf 'PASS: local Unix-socket session-scoped slot migration harness\n'
