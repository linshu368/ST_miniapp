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

echo "apply 20260922_daily_checkin_vip_bonus.sql"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 \
  -f "$ROOT/packages/shared/migrations/20260922_daily_checkin_vip_bonus.sql" \
  >/dev/null

echo "run t3 check-in scenarios"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 \
  -f "$ROOT/packages/shared/migrations/tests/vip_checkin_t3_scenarios.sql" \
  >/dev/null

CHECKIN_USER="00000000-0000-4000-8000-000000000047"
VIP_CHECKIN_USER="00000000-0000-4000-8000-000000000048"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 >/dev/null <<SQL
INSERT INTO app_core.users (id) VALUES ('$CHECKIN_USER'), ('$VIP_CHECKIN_USER');
INSERT INTO billing.user_wallets (user_id, main_credits, bonus_credits)
VALUES ('$CHECKIN_USER', 3, 0), ('$VIP_CHECKIN_USER', 3, 0);
INSERT INTO billing.vip_memberships (user_id, valid_from, valid_until, last_plan_id)
VALUES ('$VIP_CHECKIN_USER', now() - interval '1 day', now() + interval '5 days', 'week');
SQL

echo "run concurrent plain check-in"
(
  psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
    "SELECT miniapp_features.claim_daily_checkin('$CHECKIN_USER');" >/dev/null
) &
(
  psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
    "SELECT miniapp_features.claim_daily_checkin('$CHECKIN_USER');" >/dev/null
) &
wait || true

PLAIN_ROWS="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT count(*) FROM miniapp_features.daily_checkins WHERE user_id='$CHECKIN_USER';")"
PLAIN_BONUS="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT bonus_credits FROM billing.user_wallets WHERE user_id='$CHECKIN_USER';")"
[[ "$PLAIN_ROWS" == "1" ]] || fail "concurrent plain check-in rows=$PLAIN_ROWS"
[[ "$PLAIN_BONUS" == "60.0" || "$PLAIN_BONUS" == "60" ]] || fail "concurrent plain bonus=$PLAIN_BONUS"

echo "run concurrent VIP check-in"
(
  psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
    "SELECT miniapp_features.claim_daily_checkin('$VIP_CHECKIN_USER');" >/dev/null
) &
(
  psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
    "SELECT miniapp_features.claim_daily_checkin('$VIP_CHECKIN_USER');" >/dev/null
) &
wait || true

VIP_ROWS="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT count(*) FROM miniapp_features.daily_checkins WHERE user_id='$VIP_CHECKIN_USER';")"
VIP_BONUS="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT bonus_credits FROM billing.user_wallets WHERE user_id='$VIP_CHECKIN_USER';")"
VIP_LEDGER="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT count(*) FROM billing.wallet_ledger WHERE user_id='$VIP_CHECKIN_USER' AND entry_type='checkin_bonus';")"
[[ "$VIP_ROWS" == "1" ]] || fail "concurrent VIP check-in rows=$VIP_ROWS"
[[ "$VIP_BONUS" == "120.0" || "$VIP_BONUS" == "120" ]] || fail "concurrent VIP bonus=$VIP_BONUS"
[[ "$VIP_LEDGER" == "1" ]] || fail "concurrent VIP ledgers=$VIP_LEDGER"

echo "prepare local invite shape"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 \
  -f "$ROOT/packages/shared/migrations/tests/vip_invite_t3_setup.sql" \
  >/dev/null

echo "apply 20260922_invite_first_paid_vip_fulfillment.sql"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 \
  -f "$ROOT/packages/shared/migrations/20260922_invite_first_paid_vip_fulfillment.sql" \
  >/dev/null

echo "run t3 invite first-paid scenarios"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 \
  -f "$ROOT/packages/shared/migrations/tests/vip_invite_t3_scenarios.sql" \
  >/dev/null

echo "prepare local llm charge shape"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 \
  -f "$ROOT/packages/shared/migrations/tests/vip_llm_t4_setup.sql" \
  >/dev/null

echo "apply 20260922_llm_vip_wallet_charge.sql"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 \
  -f "$ROOT/packages/shared/migrations/20260922_llm_vip_wallet_charge.sql" \
  >/dev/null

echo "run t4 llm charge scenarios"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 \
  -f "$ROOT/packages/shared/migrations/tests/vip_llm_t4_scenarios.sql" \
  >/dev/null

LLM_USER="00000000-0000-4000-8000-0000000000c1"
LLM_KEY="00000000-0000-4000-8000-000000000201"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 >/dev/null <<SQL
INSERT INTO app_core.users (id) VALUES ('$LLM_USER');
INSERT INTO billing.user_wallets (user_id, main_credits, bonus_credits) VALUES ('$LLM_USER', 100, 0);
SQL

echo "run concurrent llm charge replay"
(
  psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
    "SELECT vip_t4_test.charge('$LLM_USER'::uuid, '$LLM_KEY'::uuid, 'gen-concur', 30, 'main_only', 'premium', 'stop');" >/dev/null
) &
(
  psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
    "SELECT vip_t4_test.charge('$LLM_USER'::uuid, '$LLM_KEY'::uuid, 'gen-concur', 30, 'main_only', 'premium', 'stop');" >/dev/null
) &
wait || true

LLM_LEDGER="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT count(*) FROM billing.wallet_ledger WHERE debit_key='$LLM_KEY';")"
LLM_MAIN="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT main_credits FROM billing.user_wallets WHERE user_id='$LLM_USER';")"
[[ "$LLM_LEDGER" == "1" ]] || fail "concurrent llm charge ledgers=$LLM_LEDGER"
[[ "$LLM_MAIN" == "70.0" || "$LLM_MAIN" == "70" ]] || fail "concurrent llm wallet=$LLM_MAIN"

echo "prepare local admin managed-config shape"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 \
  -f "$ROOT/packages/shared/migrations/fixtures/vip_strategy_admin_harness.sql" \
  >/dev/null

echo "apply 20260923_vip_strategy_config.sql"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 \
  -f "$ROOT/packages/shared/migrations/20260923_vip_strategy_config.sql" \
  >/dev/null

echo "run t3a strategy scenarios"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 \
  -f "$ROOT/packages/shared/migrations/tests/vip_strategy_t3a_scenarios.sql" \
  >/dev/null

LIMIT_USER="00000000-0000-4000-8000-0000000000e1"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 >/dev/null <<SQL
INSERT INTO app_core.users (id) VALUES ('$LIMIT_USER');
UPDATE app_core.runtime_config
SET value = '{"voice":4,"basic_image":3}'::jsonb
WHERE key = 'feature_free_trial_limits';
SQL

echo "run concurrent free-trial reserve at published limit 4"
for n in 1 2 3 4 5; do
  psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
    "SELECT billing.reserve_feature_free_trial('$LIMIT_USER'::uuid,'voice','concur-limit-$n');" >/dev/null &
done
wait

LIMIT_OCCUPY="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT count(*) FROM billing.feature_free_trials WHERE user_id='$LIMIT_USER' AND feature='voice' AND status='reserved';")"
[[ "$LIMIT_OCCUPY" == "4" ]] || fail "concurrent published limit occupancy=$LIMIT_OCCUPY"

REPLAY_REF="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT reference_id FROM billing.feature_free_trials WHERE user_id='$LIMIT_USER' AND feature='voice' AND status='reserved' ORDER BY reference_id LIMIT 1;")"
REPLAY_A="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT billing.reserve_feature_free_trial('$LIMIT_USER'::uuid,'voice','${REPLAY_REF}')->>'status';")"
[[ "$REPLAY_A" == "already_reserved" ]] || fail "replay status=$REPLAY_A ref=$REPLAY_REF"

echo "prepare experience ordinal stubs at 1..3"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE SCHEMA IF NOT EXISTS experience;
CREATE TABLE experience.chat_message_audio (
  id uuid PRIMARY KEY,
  free_trial_ordinal integer,
  CONSTRAINT chat_message_audio_free_trial_ordinal_check
    CHECK (free_trial_ordinal IS NULL OR free_trial_ordinal BETWEEN 1 AND 3)
);
CREATE TABLE experience.chat_message_images (
  id uuid PRIMARY KEY,
  is_current boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending',
  billing_mode text NOT NULL DEFAULT 'paid',
  image_tier text NOT NULL DEFAULT 'basic',
  debit_ledger_id uuid,
  credits_charged numeric NOT NULL DEFAULT 0,
  free_trial_ordinal integer,
  CONSTRAINT chat_message_images_free_trial_ordinal_check
    CHECK (free_trial_ordinal IS NULL OR free_trial_ordinal BETWEEN 1 AND 3),
  CONSTRAINT chat_message_images_current_requires_charged_ready CHECK (
    NOT is_current
    OR (status = 'ready' AND free_trial_ordinal BETWEEN 1 AND 3)
  )
);
SQL

echo "apply 20260923_vip_strategy_media_limit_alignment.sql"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 \
  -f "$ROOT/packages/shared/migrations/20260923_vip_strategy_media_limit_alignment.sql" \
  >/dev/null

AUDIO_ORDINAL="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'chat_message_audio_free_trial_ordinal_check';")"
[[ "$AUDIO_ORDINAL" == *"<= 20"* ]] || fail "audio ordinal constraint=$AUDIO_ORDINAL"

echo "run t5 voice/image free-trial scenarios"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 \
  -f "$ROOT/packages/shared/migrations/tests/vip_media_t5_scenarios.sql" \
  >/dev/null

T5_USER="00000000-0000-4000-8000-000000000509"
psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 >/dev/null <<SQL
INSERT INTO app_core.users (id) VALUES ('$T5_USER');
UPDATE app_core.runtime_config
SET value = '{"voice":1,"basic_image":1}'::jsonb
WHERE key = 'feature_free_trial_limits';
SQL

echo "run concurrent last voice ordinal"
for n in 1 2; do
  psql --no-psqlrc -d "$DATABASE_URL" --set ON_ERROR_STOP=1 -c \
    "SELECT billing.reserve_feature_free_trial('$T5_USER'::uuid,'voice','t5-concur-$n');" >/dev/null &
done
wait

T5_VOICE="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT count(*) FROM billing.feature_free_trials WHERE user_id='$T5_USER' AND feature='voice' AND status='reserved';")"
T5_IMAGE="$(psql --no-psqlrc -d "$DATABASE_URL" -At -c "SELECT count(*) FROM billing.feature_free_trials WHERE user_id='$T5_USER' AND feature='basic_image';")"
[[ "$T5_VOICE" == "1" ]] || fail "concurrent last voice occupancy=$T5_VOICE"
[[ "$T5_IMAGE" == "0" ]] || fail "concurrent voice race touched image=$T5_IMAGE"

echo "All T2, T3, T4, T3A and T5 VIP billing local checks passed."
