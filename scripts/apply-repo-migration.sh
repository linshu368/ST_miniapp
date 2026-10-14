#!/usr/bin/env bash
# GitHub Actions Database Migration 的唯一执行入口。
# 查账本、跑 SQL、写账本在同一次调用里完成，不要把这三步拆回 workflow 的三个 step。
#
# 环境变量：
#   DATABASE_URL          必填。Session pooler 连接串。
#   MIGRATION_FILE        必填。仓库内 SQL 文件路径。
#   APPLIED_BY            选填。默认当前 OS 用户；Actions 传 github.actor。
#   ENVIRONMENT           选填。test | production。production 会拒绝 104。
#   FORCE_RERUN           选填。true 时允许对 checksum 一致的已记录文件再跑一遍 SQL。
#   ABANDON_CLAIM          选填。true 时仅废弃 checksum 已漂移、且尚未记账的失败认领。
#   CLAIM_ABANDON_REASON   ABANDON_CLAIM=true 时必填，写入不可变事件审计。
#   REPO_MIGRATION_FAIL_RECORD  测试用。1 时故意在 SQL 成功后不记账，验证续跑。
#
# 退出码：0 成功；其余失败。stderr 带 MIGRATION_* 前缀，方便日志检索。
set -euo pipefail

LEDGER_FILE="20260910_schema_migrations_ledger.sql"
FORBIDDEN_PROD_FILE="104_rollback_voice_billing.sql"

ENVIRONMENT="${ENVIRONMENT:-}"
FORCE_RERUN="${FORCE_RERUN:-false}"
ABANDON_CLAIM="${ABANDON_CLAIM:-false}"
CLAIM_ABANDON_REASON="${CLAIM_ABANDON_REASON:-}"
APPLIED_BY="${APPLIED_BY:-$(id -un)}"
MIGRATION_FILE="${MIGRATION_FILE:-}"
DATABASE_URL="${DATABASE_URL:-}"

die() {
  echo "$1" >&2
  exit 1
}

[[ -n "$DATABASE_URL" ]] || die "MIGRATION_USAGE: DATABASE_URL is required"
[[ -n "$MIGRATION_FILE" ]] || die "MIGRATION_USAGE: MIGRATION_FILE is required"
[[ -f "$MIGRATION_FILE" ]] || die "MIGRATION_USAGE: migration file not found: $MIGRATION_FILE"

MIGRATION_NAME="$(basename "$MIGRATION_FILE")"
if [[ ! "$MIGRATION_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
  die "MIGRATION_USAGE: unexpected characters in filename: $MIGRATION_NAME"
fi

if [[ "$ENVIRONMENT" == "production" && "$MIGRATION_NAME" == "$FORBIDDEN_PROD_FILE" ]]; then
  die "MIGRATION_PROD_104_FORBIDDEN: $FORBIDDEN_PROD_FILE 只用于 test 回滚 101/102，生产从未执行过那两份迁移"
fi

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# libpq 不认 Prisma 的 connection_limit / pool_timeout / pgbouncer。
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
# urlunparse 在无 host 时会把 postgresql:///db 收成 postgresql:/db，libpq 不再当 URL 认。
if not parsed.hostname:
    sys.stdout.write(raw)
    raise SystemExit
allowed = {"sslmode", "connect_timeout", "options", "application_name"}
query = [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True) if key in allowed]
sys.stdout.write(urlunparse(parsed._replace(query=urlencode(query))))
PY
}

DB_URL="$(sanitize_db_url "$DATABASE_URL")"
CHECKSUM="$(file_sha256 "$MIGRATION_FILE")"

sql_literal() {
  local value="$1"
  value="${value//\'/\'\'}"
  printf "'%s'" "$value"
}

NAME_LIT="$(sql_literal "$MIGRATION_NAME")"
SUM_LIT="$(sql_literal "$CHECKSUM")"
BY_LIT="$(sql_literal "$APPLIED_BY")"

psql_cmd() {
  psql --no-psqlrc -d "$DB_URL" --set ON_ERROR_STOP=1 "$@"
}

psql_at() {
  psql_cmd -At "$@"
}

has_column() {
  local schema="$1" table="$2" column="$3"
  psql_at -c "SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = '${schema}'
      AND table_name = '${table}'
      AND column_name = '${column}'
  );"
}

existing_checksum() {
  psql_at -c "SELECT checksum FROM supabase_migrations.repo_migrations WHERE filename = ${NAME_LIT};"
}

claim_checksum() {
  psql_at -c "SELECT checksum FROM supabase_migrations.repo_migration_claims WHERE filename = ${NAME_LIT};"
}

insert_claim() {
  psql_cmd -c \
    "INSERT INTO supabase_migrations.repo_migration_claims (filename, checksum, claimed_by)
     VALUES (${NAME_LIT}, ${SUM_LIT}, ${BY_LIT})
     ON CONFLICT (filename) DO NOTHING;"
}

delete_claim() {
  psql_cmd -c "DELETE FROM supabase_migrations.repo_migration_claims WHERE filename = ${NAME_LIT};" >/dev/null
}

insert_ledger() {
  psql_cmd -c \
    "INSERT INTO supabase_migrations.repo_migrations (filename, checksum, applied_by)
     VALUES (${NAME_LIT}, ${SUM_LIT}, ${BY_LIT});"
}

insert_event() {
  local action="$1"
  local action_lit
  action_lit="$(sql_literal "$action")"
  if [[ "$(has_column supabase_migrations repo_migration_events filename)" != "t" ]]; then
    return 0
  fi
  psql_cmd -c \
    "INSERT INTO supabase_migrations.repo_migration_events (filename, checksum, applied_by, action)
     VALUES (${NAME_LIT}, ${SUM_LIT}, ${BY_LIT}, ${action_lit});" \
    >/dev/null || echo "warning: failed to append repo_migration_events (${action})" >&2
}

abandon_claim() {
  local claimed_checksum="$1"
  local claimed_lit reason_lit
  claimed_lit="$(sql_literal "$claimed_checksum")"
  reason_lit="$(sql_literal "$CLAIM_ABANDON_REASON")"

  # 锁住 claim 后在同一事务里二次确认前置条件，避免检查与删除之间被并发 apply 穿透。
  psql_cmd -c "
    BEGIN;
    DO \$\$
    DECLARE
      v_claimed text;
    BEGIN
      SELECT checksum INTO v_claimed
      FROM supabase_migrations.repo_migration_claims
      WHERE filename = ${NAME_LIT}
      FOR UPDATE;

      IF v_claimed IS NULL THEN
        RAISE EXCEPTION 'MIGRATION_CLAIM_ABANDON_UNAVAILABLE: no unfinished claim for %', ${NAME_LIT};
      END IF;
      IF v_claimed <> ${claimed_lit} THEN
        RAISE EXCEPTION 'MIGRATION_CLAIM_ABANDON_UNAVAILABLE: claim checksum changed for %', ${NAME_LIT};
      END IF;
      IF EXISTS (
        SELECT 1 FROM supabase_migrations.repo_migrations WHERE filename = ${NAME_LIT}
      ) THEN
        RAISE EXCEPTION 'MIGRATION_CLAIM_ABANDON_UNAVAILABLE: ledger row exists for %', ${NAME_LIT};
      END IF;
      IF v_claimed = ${SUM_LIT} THEN
        RAISE EXCEPTION 'MIGRATION_CLAIM_ABANDON_UNAVAILABLE: matching claim must resume normally for %', ${NAME_LIT};
      END IF;

      INSERT INTO supabase_migrations.repo_migration_events
        (filename, checksum, applied_by, action, details)
      VALUES (
        ${NAME_LIT},
        v_claimed,
        ${BY_LIT},
        'abandon_claim',
        jsonb_build_object(
          'reason', ${reason_lit},
          'replacement_checksum', ${SUM_LIT}
        )
      );

      DELETE FROM supabase_migrations.repo_migration_claims
      WHERE filename = ${NAME_LIT} AND checksum = v_claimed;
    END
    \$\$;
    COMMIT;" >/dev/null
}

record_ledger_with_retry() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if insert_ledger >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

apply_sql() {
  # 迁移文件自己带 BEGIN/COMMIT。这里不再包一层，避免套娃事务把文件里的 COMMIT 提交掉外层。
  psql_cmd --file "$MIGRATION_FILE"
}

LEDGER_EXISTS="$(has_column supabase_migrations repo_migrations filename)"
CLAIMS_EXIST="$(has_column supabase_migrations repo_migration_claims filename)"
EVENTS_EXIST="$(has_column supabase_migrations repo_migration_events filename)"
EVENT_DETAILS_EXIST="$(has_column supabase_migrations repo_migration_events details)"

if [[ "$ABANDON_CLAIM" != "true" && "$ABANDON_CLAIM" != "false" ]]; then
  die "MIGRATION_USAGE: ABANDON_CLAIM must be true or false"
fi

if [[ "$ABANDON_CLAIM" == "true" ]]; then
  [[ "$FORCE_RERUN" != "true" ]] || die "MIGRATION_CLAIM_ABANDON_UNAVAILABLE: force_rerun cannot be combined with abandon_claim"
  [[ -n "$CLAIM_ABANDON_REASON" ]] || die "MIGRATION_CLAIM_ABANDON_UNAVAILABLE: CLAIM_ABANDON_REASON is required"
  [[ "${#CLAIM_ABANDON_REASON}" -le 500 ]] || die "MIGRATION_CLAIM_ABANDON_UNAVAILABLE: CLAIM_ABANDON_REASON must be at most 500 characters"
  [[ "$LEDGER_EXISTS" == "t" && "$CLAIMS_EXIST" == "t" && "$EVENTS_EXIST" == "t" && "$EVENT_DETAILS_EXIST" == "t" ]] \
    || die "MIGRATION_CLAIM_ABANDON_UNAVAILABLE: apply the claim-recovery ledger migration first"

  STORED_CHECKSUM="$(existing_checksum || true)"
  [[ -z "$STORED_CHECKSUM" ]] || die "MIGRATION_CLAIM_ABANDON_UNAVAILABLE: ledger row already exists for ${MIGRATION_NAME}"
  CLAIMED="$(claim_checksum || true)"
  [[ -n "$CLAIMED" ]] || die "MIGRATION_CLAIM_ABANDON_UNAVAILABLE: no unfinished claim for ${MIGRATION_NAME}"
  [[ "$CLAIMED" != "$CHECKSUM" ]] || die "MIGRATION_CLAIM_ABANDON_UNAVAILABLE: matching claim must resume normally for ${MIGRATION_NAME}"

  abandon_claim "$CLAIMED"
  echo "Abandoned stale claim for ${MIGRATION_NAME}; no migration SQL was executed."
  exit 0
fi

if [[ "$LEDGER_EXISTS" != "t" && "$MIGRATION_NAME" != "$LEDGER_FILE" ]]; then
  die "MIGRATION_LEDGER_MISSING: 先执行 packages/shared/migrations/${LEDGER_FILE}，不要在账本表不存在时静默放行"
fi

if [[ "$LEDGER_EXISTS" == "t" ]]; then
  STORED_CHECKSUM="$(existing_checksum || true)"
  if [[ -n "${STORED_CHECKSUM}" ]]; then
    if [[ "$STORED_CHECKSUM" != "$CHECKSUM" ]]; then
      die "MIGRATION_CHECKSUM_DRIFT: ${MIGRATION_NAME} 已执行过，但文件 sha256 与账本不一致（账本 ${STORED_CHECKSUM} / 文件 ${CHECKSUM}）。修正请写新迁移，不要改旧文件再跑"
    fi
    if [[ "$FORCE_RERUN" != "true" ]]; then
      if [[ "$CLAIMS_EXIST" == "t" ]]; then
        delete_claim || true
      fi
      die "MIGRATION_ALREADY_APPLIED: ${MIGRATION_NAME} — 如确需重跑且文件未改，请在 workflow 入参勾选 force_rerun"
    fi
  fi
fi

RESUME_ONLY=0
if [[ "$LEDGER_EXISTS" == "t" && -z "${STORED_CHECKSUM:-}" && "$CLAIMS_EXIST" == "t" ]]; then
  CLAIMED="$(claim_checksum || true)"
  if [[ -n "$CLAIMED" && "$CLAIMED" != "$CHECKSUM" ]]; then
    die "MIGRATION_CHECKSUM_DRIFT: ${MIGRATION_NAME} 有未完成认领，但 checksum 已变（认领 ${CLAIMED} / 文件 ${CHECKSUM}）"
  fi
  if [[ -n "$CLAIMED" ]]; then
    RESUME_ONLY=1
  fi
fi

if [[ "$CLAIMS_EXIST" == "t" && -z "${STORED_CHECKSUM:-}" ]]; then
  insert_claim >/dev/null
  CLAIMED="$(claim_checksum || true)"
  if [[ -n "$CLAIMED" && "$CLAIMED" != "$CHECKSUM" ]]; then
    die "MIGRATION_CHECKSUM_DRIFT: ${MIGRATION_NAME} 认领行 checksum 与当前文件不一致"
  fi
fi

apply_sql

if [[ "${REPO_MIGRATION_FAIL_RECORD:-}" == "1" ]]; then
  die "MIGRATION_RECORD_FAILED: 测试注入。SQL 已执行但故意不记账。认领行（若有）保留，下次同文件再跑以补账本"
fi

if [[ -n "${STORED_CHECKSUM:-}" ]]; then
  # force_rerun：保留首次 applied_at / checksum，只追加事件。
  insert_event force_rerun
  echo "Re-applied ${MIGRATION_NAME} (force_rerun); original ledger row left unchanged."
  exit 0
fi

if ! record_ledger_with_retry; then
  die "MIGRATION_RECORD_FAILED: ${MIGRATION_NAME} SQL 已执行但账本写入失败。不要改文件。修好后用同一文件再跑（认领行还在则续写账本）"
fi

insert_event apply
if [[ "$CLAIMS_EXIST" == "t" ]]; then
  delete_claim || true
fi

if [[ "$RESUME_ONLY" == "1" ]]; then
  echo "Recorded ${MIGRATION_NAME} after interrupted apply (checksum ${CHECKSUM})."
else
  echo "Applied ${MIGRATION_NAME} (checksum ${CHECKSUM})."
fi
