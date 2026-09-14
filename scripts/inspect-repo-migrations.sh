#!/usr/bin/env bash
# 仓库日期命名迁移 ↔ 账本 ↔ 关键库对象 三方互证。只读，不改库。
#
# 环境变量：
#   DATABASE_URL    必填。
#   MIGRATIONS_DIR  选填。默认 packages/shared/migrations。
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-packages/shared/migrations}"

[[ -n "$DATABASE_URL" ]] || { echo "MIGRATION_USAGE: DATABASE_URL is required" >&2; exit 1; }
[[ -d "$MIGRATIONS_DIR" ]] || { echo "MIGRATION_USAGE: migrations dir not found: $MIGRATIONS_DIR" >&2; exit 1; }

sanitize_db_url() {
  if ! command -v python3 >/dev/null 2>&1; then
    printf '%s' "$1"
    return
  fi
  python3 - "$1" <<'PY'
import sys
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

raw = sys.argv[1]
parsed = urlparse(raw)
if not parsed.hostname:
    sys.stdout.write(raw)
    raise SystemExit
allowed = {"sslmode", "connect_timeout", "options", "application_name"}
query = [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True) if key in allowed]
sys.stdout.write(urlunparse(parsed._replace(query=urlencode(query))))
PY
}

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

DB_URL="$(sanitize_db_url "$DATABASE_URL")"
psql_at() {
  psql --no-psqlrc -d "$DB_URL" --set ON_ERROR_STOP=1 -At "$@"
}

echo "### Migration ledger inspect"
echo ""

PROBES="$(psql_at -c "
SELECT concat_ws('|',
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='supabase_migrations' AND table_name='repo_migrations' AND column_name='filename'
  ) THEN 'ledger=yes' ELSE 'ledger=no' END,
  CASE WHEN to_regprocedure('billing.grant_bonus_credits(uuid,numeric,text,text,text,jsonb)') IS NOT NULL
    THEN 'r3_grant_bonus_credits=yes' ELSE 'r3_grant_bonus_credits=no' END,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='app_core' AND table_name='users' AND column_name='st_handle' AND is_nullable='YES'
  ) THEN 'st_handle_nullable=yes'
  WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='app_core' AND table_name='users' AND column_name='st_handle'
  ) THEN 'st_handle_nullable=no'
  ELSE 'st_handle_column=missing' END,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='experience' AND table_name='chat_history' AND column_name='llm_billing_snapshot'
  ) THEN 'a_snapshot=yes' ELSE 'a_snapshot=no' END,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='experience' AND table_name='chat_history' AND column_name='llm_billing_settled_at'
  ) THEN 'a_settled_at=yes' ELSE 'a_settled_at=no' END
);
")"
echo "Object probes: ${PROBES}"
echo ""

LEDGER_EXISTS="$(psql_at -c "SELECT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema='supabase_migrations' AND table_name='repo_migrations' AND column_name='filename'
);")"

if [[ "$LEDGER_EXISTS" != "t" ]]; then
  echo "Ledger table supabase_migrations.repo_migrations is missing."
  echo "Apply packages/shared/migrations/20260910_schema_migrations_ledger.sql first."
  echo ""
fi

echo "| file | file_sha256 | ledger | verdict |"
echo "| --- | --- | --- | --- |"

shopt -s nullglob
dated_files=("$MIGRATIONS_DIR"/20[0-9][0-9][0-9][0-9][0-9][0-9]_*.sql)
IFS=$'\n' dated_files=($(printf '%s\n' "${dated_files[@]}" | LC_ALL=C sort))
unset IFS

DRIFT=0
MISSING=0

for path in "${dated_files[@]}"; do
  name="$(basename "$path")"
  sum="$(file_sha256 "$path")"
  if [[ "$LEDGER_EXISTS" != "t" ]]; then
    echo "| \`${name}\` | \`${sum}\` | (no table) | not_applied |"
    MISSING=$((MISSING + 1))
    continue
  fi
  stored="$(psql_at -c "SELECT checksum FROM supabase_migrations.repo_migrations WHERE filename = '${name}';" || true)"
  if [[ -z "$stored" ]]; then
    echo "| \`${name}\` | \`${sum}\` | (absent) | not_applied |"
    MISSING=$((MISSING + 1))
  elif [[ "$stored" == "$sum" ]]; then
    echo "| \`${name}\` | \`${sum}\` | match | applied |"
  else
    echo "| \`${name}\` | \`${sum}\` | \`${stored}\` | DRIFT |"
    DRIFT=$((DRIFT + 1))
  fi
done

echo ""
echo "Dated migrations: ${#dated_files[@]} · not_applied: ${MISSING} · drift: ${DRIFT}"
echo ""
echo "Frozen 111/112 are not in the dated ledger (存量不回填). Read st_handle_* probes above."
echo "R3 / A also have object probes: function and chat_history columns must agree with the ledger row."

if [[ "$DRIFT" -gt 0 ]]; then
  echo "MIGRATION_CHECKSUM_DRIFT: inspect found ${DRIFT} drifted file(s)" >&2
  exit 1
fi
