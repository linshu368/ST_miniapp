#!/usr/bin/env bash
# 本地账本协议回归。对着本机 Postgres 建临时库，不连 test / production。
# 覆盖 C 的三条：同一文件重跑拒绝、checksum 漂移拒绝、Apply 成功 Record 失败后续跑能补记账。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DB_NAME="st_repo_migration_c_test"
export DATABASE_URL="postgresql:///${DB_NAME}"
APPLY=(bash "$ROOT/scripts/apply-repo-migration.sh")
INSPECT=(bash "$ROOT/scripts/inspect-repo-migrations.sh")

fail() {
  echo "FAIL: $1" >&2
  dropdb --if-exists "$DB_NAME" >/dev/null 2>&1 || true
  exit 1
}

pass() {
  echo "ok: $1"
}

dropdb --if-exists "$DB_NAME" >/dev/null
createdb "$DB_NAME"
# 20260910 / 20260914 会 REVOKE anon / authenticated。角色是集群级的，只补不删。
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
  "DO \$\$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
       CREATE ROLE anon NOLOGIN;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
       CREATE ROLE authenticated NOLOGIN;
     END IF;
   END \$\$;" >/dev/null

cleanup() {
  dropdb --if-exists "$DB_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

out="$(mktemp)"
err="$(mktemp)"

run_apply() {
  local expect_code="$1"
  shift
  set +e
  "$@" >"$out" 2>"$err"
  local code=$?
  set -e
  if [[ "$code" -ne "$expect_code" ]]; then
    echo "stdout: $(cat "$out")" >&2
    echo "stderr: $(cat "$err")" >&2
    fail "expected exit ${expect_code}, got ${code} ($*)"
  fi
}

# 1. production 拦 104，连库前就拒绝。
run_apply 1 env ENVIRONMENT=production MIGRATION_FILE="$ROOT/packages/shared/migrations/104_rollback_voice_billing.sql" DATABASE_URL="$DATABASE_URL" "${APPLY[@]}"
grep -q 'MIGRATION_PROD_104_FORBIDDEN' "$err" || fail "104 guard did not fire"
pass "production rejects 104"

# 2. 账本表不存在时拒绝其它文件，不再静默放行。
run_apply 1 env MIGRATION_FILE="$ROOT/packages/shared/migrations/20260914_repo_migration_ledger_events.sql" DATABASE_URL="$DATABASE_URL" "${APPLY[@]}"
grep -q 'MIGRATION_LEDGER_MISSING' "$err" || fail "missing ledger did not fail"
pass "missing ledger refuses later files"

# 3. 先跑账本迁移，再跑应拒绝。
run_apply 0 env APPLIED_BY=c-test MIGRATION_FILE="$ROOT/packages/shared/migrations/20260910_schema_migrations_ledger.sql" DATABASE_URL="$DATABASE_URL" "${APPLY[@]}"
run_apply 1 env APPLIED_BY=c-test MIGRATION_FILE="$ROOT/packages/shared/migrations/20260910_schema_migrations_ledger.sql" DATABASE_URL="$DATABASE_URL" "${APPLY[@]}"
grep -q 'MIGRATION_ALREADY_APPLIED' "$err" || fail "rerun did not report ALREADY_APPLIED"
pass "second apply of ledger is rejected"

# 4. checksum 漂移。
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
  "UPDATE supabase_migrations.repo_migrations SET checksum = 'deadbeef' WHERE filename = '20260910_schema_migrations_ledger.sql';" \
  >/dev/null
run_apply 1 env MIGRATION_FILE="$ROOT/packages/shared/migrations/20260910_schema_migrations_ledger.sql" DATABASE_URL="$DATABASE_URL" "${APPLY[@]}"
grep -q 'MIGRATION_CHECKSUM_DRIFT' "$err" || fail "tampered checksum was not detected"
# force_rerun 也不能覆盖漂移。
run_apply 1 env FORCE_RERUN=true MIGRATION_FILE="$ROOT/packages/shared/migrations/20260910_schema_migrations_ledger.sql" DATABASE_URL="$DATABASE_URL" "${APPLY[@]}"
grep -q 'MIGRATION_CHECKSUM_DRIFT' "$err" || fail "force_rerun must not bypass drift"
pass "checksum drift is rejected even with force_rerun"

# 5. 恢复 checksum，force_rerun 保留首次 applied_at。
REAL_SUM="$(shasum -a 256 "$ROOT/packages/shared/migrations/20260910_schema_migrations_ledger.sql" | awk '{print $1}')"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
  "UPDATE supabase_migrations.repo_migrations SET checksum = '${REAL_SUM}' WHERE filename = '20260910_schema_migrations_ledger.sql';" \
  >/dev/null
BEFORE="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT applied_at::text FROM supabase_migrations.repo_migrations WHERE filename = '20260910_schema_migrations_ledger.sql';")"
sleep 1
run_apply 0 env FORCE_RERUN=true APPLIED_BY=c-rerun MIGRATION_FILE="$ROOT/packages/shared/migrations/20260910_schema_migrations_ledger.sql" DATABASE_URL="$DATABASE_URL" "${APPLY[@]}"
AFTER="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT applied_at::text || '|' || applied_by FROM supabase_migrations.repo_migrations WHERE filename = '20260910_schema_migrations_ledger.sql';")"
[[ "$AFTER" == "${BEFORE}|c-test" ]] || fail "force_rerun overwrote first ledger row: $AFTER"
pass "force_rerun keeps original applied_at and applied_by"

# 6. 事件表 + force_rerun 只追加历史，不改首次行。
run_apply 0 env APPLIED_BY=c-test MIGRATION_FILE="$ROOT/packages/shared/migrations/20260914_repo_migration_ledger_events.sql" DATABASE_URL="$DATABASE_URL" "${APPLY[@]}"
EVENTS_AT="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT applied_at::text FROM supabase_migrations.repo_migrations WHERE filename = '20260914_repo_migration_ledger_events.sql';")"
run_apply 0 env FORCE_RERUN=true APPLIED_BY=c-rerun MIGRATION_FILE="$ROOT/packages/shared/migrations/20260914_repo_migration_ledger_events.sql" DATABASE_URL="$DATABASE_URL" "${APPLY[@]}"
EVENTS_AFTER="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT applied_at::text || '|' || applied_by FROM supabase_migrations.repo_migrations WHERE filename = '20260914_repo_migration_ledger_events.sql';")"
[[ "$EVENTS_AFTER" == "${EVENTS_AT}|c-test" ]] || fail "force_rerun overwrote 20260914 ledger row"
EVENT_KINDS="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT string_agg(action, ',' ORDER BY id) FROM supabase_migrations.repo_migration_events WHERE filename = '20260914_repo_migration_ledger_events.sql';")"
[[ "$EVENT_KINDS" == "apply,force_rerun" ]] || fail "expected apply,force_rerun events, got $EVENT_KINDS"
pass "force_rerun appends events and keeps first 20260914 row"

# 7. Apply/Record 中断后续跑。

FIXTURE="$(mktemp "${TMPDIR:-/tmp}/c-fixture.XXXXXX.sql")"
cat >"$FIXTURE" <<'SQL'
BEGIN;
CREATE SCHEMA IF NOT EXISTS c_fixture;
CREATE TABLE IF NOT EXISTS c_fixture.marker (n int PRIMARY KEY);
INSERT INTO c_fixture.marker (n) VALUES (1) ON CONFLICT (n) DO NOTHING;
COMMIT;
SQL

run_apply 1 env REPO_MIGRATION_FAIL_RECORD=1 APPLIED_BY=c-test MIGRATION_FILE="$FIXTURE" DATABASE_URL="$DATABASE_URL" "${APPLY[@]}"
grep -q 'MIGRATION_RECORD_FAILED' "$err" || fail "injected record failure not reported"
MARKER="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c 'SELECT count(*) FROM c_fixture.marker;')"
[[ "$MARKER" == "1" ]] || fail "fixture SQL did not apply before record failure"
LEDGER_ROW="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT count(*) FROM supabase_migrations.repo_migrations WHERE filename = '$(basename "$FIXTURE")';")"
[[ "$LEDGER_ROW" == "0" ]] || fail "ledger should be empty after injected record failure"
CLAIM_ROW="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT count(*) FROM supabase_migrations.repo_migration_claims WHERE filename = '$(basename "$FIXTURE")';")"
[[ "$CLAIM_ROW" == "1" ]] || fail "claim should remain after record failure"

run_apply 0 env APPLIED_BY=c-test MIGRATION_FILE="$FIXTURE" DATABASE_URL="$DATABASE_URL" "${APPLY[@]}"
MARKER="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c 'SELECT count(*) FROM c_fixture.marker;')"
[[ "$MARKER" == "1" ]] || fail "resume re-apply double-inserted fixture"
LEDGER_ROW="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT count(*) FROM supabase_migrations.repo_migrations WHERE filename = '$(basename "$FIXTURE")';")"
[[ "$LEDGER_ROW" == "1" ]] || fail "resume did not record ledger"
CLAIM_ROW="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT count(*) FROM supabase_migrations.repo_migration_claims WHERE filename = '$(basename "$FIXTURE")';")"
[[ "$CLAIM_ROW" == "0" ]] || fail "claim should be cleared after successful record"
pass "interrupted record can resume without double-inserting"

# 8. inspect 能列出日期命名文件，漂移时非 0。
run_apply 0 env DATABASE_URL="$DATABASE_URL" MIGRATIONS_DIR="$ROOT/packages/shared/migrations" "${INSPECT[@]}"
grep -q 'a_snapshot=no' "$out" || fail "inspect should probe A columns on empty local db"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
  "UPDATE supabase_migrations.repo_migrations SET checksum = 'deadbeef' WHERE filename = '20260910_schema_migrations_ledger.sql';" \
  >/dev/null
run_apply 1 env DATABASE_URL="$DATABASE_URL" MIGRATIONS_DIR="$ROOT/packages/shared/migrations" "${INSPECT[@]}"
grep -q 'DRIFT' "$out" || grep -q 'MIGRATION_CHECKSUM_DRIFT' "$err" || fail "inspect did not flag drift"
pass "inspect reports object probes and drift"

rm -f "$FIXTURE" "$out" "$err"
echo "All repo-migration ledger protocol checks passed."
