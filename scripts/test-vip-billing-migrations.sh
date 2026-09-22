#!/usr/bin/env bash
# Local T2 VIP billing migration + RPC regression.
# Uses a throwaway local Postgres database. Never connects to test or production.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DB_NAME="st_vip_t2_billing_test"
export DATABASE_URL="postgresql:///${DB_NAME}"

fail() {
  echo "FAIL: $1" >&2
  dropdb --if-exists "$DB_NAME" >/dev/null 2>&1 || true
  exit 1
}

command -v createdb >/dev/null || fail "createdb not found; install local PostgreSQL client/server"
command -v psql >/dev/null || fail "psql not found"

dropdb --if-exists "$DB_NAME" >/dev/null
createdb "$DB_NAME"

cleanup() {
  dropdb --if-exists "$DB_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 \
  -f "$ROOT/packages/shared/migrations/fixtures/vip_billing_t2_harness.sql" \
  >/dev/null

for file in \
  20260921_vip_billing_schema.sql \
  20260921_wallet_debit_refund.sql \
  20260921_vip_payment_fulfillment.sql \
  20260921_feature_free_trial_checkin_reminder.sql
do
  echo "apply $file"
  psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 \
    -f "$ROOT/packages/shared/migrations/$file" \
    >/dev/null
done

echo "run sequential scenarios"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 \
  -f "$ROOT/packages/shared/migrations/tests/vip_billing_t2_scenarios.sql" \
  >/dev/null

U="00000000-0000-4000-8000-00000000000a"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 >/dev/null <<SQL
INSERT INTO app_core.users (id) VALUES ('$U');
INSERT INTO billing.user_wallets (user_id, main_credits, bonus_credits) VALUES ('$U', 80, 0);
INSERT INTO billing.payment_orders (
  id, user_id, status, payment_type, amount_cents, credits_amount, bonus_credits, expires_at,
  product_type, product_id, vip_duration_days, vip_bonus_credits
) VALUES
  ('VIP_CONCUR_1', '$U', 'pending', 'wxpay', 1399, 0, 0, now() + interval '1 hour', 'vip', 'week', 7, 0),
  ('VIP_CONCUR_2', '$U', 'pending', 'wxpay', 1399, 0, 0, now() + interval '1 hour', 'vip', 'week', 7, 0);
SQL

echo "run concurrent debit replay"
(
  psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
    "SELECT billing.apply_wallet_debit('$U'::uuid,'debit-concur','main_only',10,'chat_debit','test','debit-concur');" >/dev/null
) &
(
  psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
    "SELECT billing.apply_wallet_debit('$U'::uuid,'debit-concur','main_only',10,'chat_debit','test','debit-concur');" >/dev/null
) &
wait

DEBIT_N="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT count(*) FROM billing.wallet_ledger WHERE debit_key='debit-concur';")"
[[ "$DEBIT_N" == "1" ]] || fail "concurrent debit produced $DEBIT_N ledgers"
MAIN_LEFT="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT main_credits FROM billing.user_wallets WHERE user_id='$U';")"
[[ "$MAIN_LEFT" == "70.0" || "$MAIN_LEFT" == "70" ]] || fail "concurrent debit wallet=$MAIN_LEFT"

echo "run concurrent distinct VIP renewals"
(
  psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
    "SELECT billing.complete_payment_order('VIP_CONCUR_1','t1','webhook');" >/dev/null
) &
(
  psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
    "SELECT billing.complete_payment_order('VIP_CONCUR_2','t2','query');" >/dev/null
) &
wait

GRANT_N="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT count(*) FROM billing.vip_purchase_grants WHERE user_id='$U';")"
[[ "$GRANT_N" == "2" ]] || fail "expected 2 VIP grants, got $GRANT_N"
DAYS="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT round(extract(epoch from (valid_until - valid_from))/86400) FROM billing.vip_memberships WHERE user_id='$U';")"
[[ "$DAYS" == "14" ]] || fail "expected 14 days stacked VIP, got $DAYS"

echo "run concurrent free-trial reserve"
(
  psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
    "SELECT billing.reserve_feature_free_trial('$U'::uuid,'voice','concur-v1');" >/dev/null
) &
(
  psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
    "SELECT billing.reserve_feature_free_trial('$U'::uuid,'voice','concur-v2');" >/dev/null
) &
(
  psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
    "SELECT billing.reserve_feature_free_trial('$U'::uuid,'voice','concur-v3');" >/dev/null
) &
(
  psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
    "SELECT billing.reserve_feature_free_trial('$U'::uuid,'voice','concur-v4');" >/dev/null
) &
wait

OCCUPY="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT count(*) FROM billing.feature_free_trials WHERE user_id='$U' AND feature='voice' AND status IN ('reserved','consumed');")"
[[ "$OCCUPY" == "3" ]] || fail "concurrent reserve occupancy=$OCCUPY"

echo "All T2 VIP billing local checks passed."
