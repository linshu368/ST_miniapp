#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261120_db_reorg_p6b1a_align_test_charges.sql as a NON-superuser:
# - no mismatched turns (production shape) → no-op;
# - mismatched turns without a TEST-only migration in the ledger → refuses, nothing changed;
# - with the TEST marker → deduction_rate aligned to the charge / dedup amount, consistent turns untouched;
# - afterwards the 6b-1a expand file passes its pre-guard and self-check; rerunning the align file is a no-op.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
align="$task_root/packages/shared/migrations/20261120_db_reorg_p6b1a_align_test_charges.sql"
expand="$task_root/packages/shared/migrations/20261120_db_reorg_p6b1a_usage_charges_expand.sql"
task_container="st-db-reorg-p6b1a-align-${RANDOM}-$$"
trap 'docker rm -f "$task_container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE;
CREATE ROLE service_role NOLOGIN;
CREATE DATABASE fixture OWNER app_admin;
SQL
psql_f() { docker exec -i "$task_container" psql -X -q -U app_admin -d fixture -v ON_ERROR_STOP=1 "$@"; }
check() { # label; SQL on stdin must print exactly "t"
  local got
  got=$(psql_f -At)
  if [[ "$got" != "t" ]]; then echo "FAIL: $1 (got: $got)"; exit 1; fi
  echo "ok: $1"
}
fixture() { # $1 = consistent | mismatched
  psql_f >/dev/null <<'SQL'
DROP SCHEMA IF EXISTS app_core, billing, experience, supabase_migrations CASCADE;
CREATE SCHEMA app_core; CREATE SCHEMA billing; CREATE SCHEMA experience; CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.repo_migrations (filename text PRIMARY KEY);
CREATE TABLE app_core.users (id uuid PRIMARY KEY);
CREATE TABLE billing.wallet_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, entry_type text, amount numeric(14,1),
  reference_type text, reference_id text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE billing.llm_usage_charges (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, charge_key uuid NOT NULL UNIQUE, generation_id text,
  user_id uuid NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE, model_id text, model_openrouter_id text NOT NULL,
  model_display_name text NOT NULL, catalog_version integer NOT NULL DEFAULT 0, pricing_config_version integer NOT NULL DEFAULT 0,
  exchange_rate numeric(14,4) NOT NULL, model_markup numeric(4,1) NOT NULL, initial_amount numeric(14,1) NOT NULL DEFAULT 0,
  calculated_amount numeric(14,1) NOT NULL DEFAULT 0, charged_amount numeric(14,1) NOT NULL DEFAULT 0,
  fallback_used boolean NOT NULL DEFAULT false, status text NOT NULL, debit_ledger_id uuid REFERENCES billing.wallet_ledger(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), reconciled_at timestamptz);
CREATE TABLE billing.llm_usage_charge_dedup (
  charge_key uuid PRIMARY KEY, generation_id text, user_id uuid NOT NULL, charged_amount numeric(14,1) NOT NULL DEFAULT 0,
  status text NOT NULL, processed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE experience.chat_history (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  llm_charge_id uuid, deduction_rate numeric(14,1), llm_billing_snapshot jsonb, llm_intended_deduction numeric(10,2),
  llm_billing_settled_at timestamptz);
INSERT INTO app_core.users VALUES ('00000000-0000-0000-00aa-000000000001');
INSERT INTO billing.wallet_ledger (user_id, entry_type, amount, reference_type, reference_id) VALUES
  ('00000000-0000-0000-00aa-000000000001', 'chat_debit', -10, 'llm_usage', '00000000-0000-0000-0c00-000000000001'),
  ('00000000-0000-0000-00aa-000000000001', 'chat_debit', -5, 'llm_usage', '00000000-0000-0000-0c00-000000000002'),
  ('00000000-0000-0000-00aa-000000000001', 'chat_debit', -3, 'llm_usage', '00000000-0000-0000-0c00-000000000003');
INSERT INTO experience.chat_history (id, user_id, status, created_at, llm_charge_id, deduction_rate, llm_billing_settled_at) VALUES
  ('00000000-0000-0000-0d00-000000000001', '00000000-0000-0000-00aa-000000000001', 'success', now() - interval '3 days', '00000000-0000-0000-0c00-000000000001', 10, now() - interval '3 days'),
  ('00000000-0000-0000-0d00-000000000002', '00000000-0000-0000-00aa-000000000001', 'success', now() - interval '3 days', '00000000-0000-0000-0c00-000000000002', 5, now() - interval '3 days'),
  ('00000000-0000-0000-0d00-000000000003', '00000000-0000-0000-00aa-000000000001', 'success', now() - interval '3 days', '00000000-0000-0000-0c00-000000000003', 3, now() - interval '3 days');
INSERT INTO billing.llm_usage_charges (charge_key, user_id, model_openrouter_id, model_display_name, exchange_rate, model_markup, charged_amount, status, created_at) VALUES
  ('00000000-0000-0000-0c00-000000000001', '00000000-0000-0000-00aa-000000000001', 'm/a', 'A', 7, 1, 10, 'charged', now() - interval '3 days'),
  ('00000000-0000-0000-0c00-000000000003', '00000000-0000-0000-00aa-000000000001', 'm/a', 'A', 7, 1, 3, 'charged', now() - interval '3 days');
INSERT INTO billing.llm_usage_charge_dedup (charge_key, user_id, charged_amount, status, processed_at) VALUES
  ('00000000-0000-0000-0c00-000000000002', '00000000-0000-0000-00aa-000000000001', 5, 'charged', now() - interval '3 days');
SQL
  if [[ "$1" == mismatched ]]; then
    # TEST-like hand edits: turn 1 (charge row) and turn 2 (dedup only) disagree with their charge amount
    psql_f >/dev/null <<'SQL'
UPDATE experience.chat_history SET deduction_rate = 8 WHERE id = '00000000-0000-0000-0d00-000000000001';
UPDATE experience.chat_history SET deduction_rate = NULL WHERE id = '00000000-0000-0000-0d00-000000000002';
SQL
  fi
}
rates() { psql_f -At -c "SELECT string_agg(COALESCE(deduction_rate::text, 'null'), ',' ORDER BY id) FROM experience.chat_history"; }

fixture consistent
out=$(psql_f <"$align" 2>&1)
[[ "$out" == *'no mismatched turns; nothing to do'* && "$(rates)" == '10.0,5.0,3.0' ]] || { echo "FAIL: consistent: $out"; exit 1; }
echo 'ok: production shape is a no-op'

fixture mismatched
if out=$(psql_f <"$align" 2>&1); then echo "FAIL: refused expected without TEST marker: $out"; exit 1; fi
[[ "$out" == *'2 mismatched turns on a database without TEST-only migrations; refusing'* && "$(rates)" == '8.0,null,3.0' ]] ||
  { echo "FAIL: refusal: $out / $(rates)"; exit 1; }
[[ "$out" == *'charge turns=1 ledger=charge:1 ledger=turn:0 no_ledger:0 diff=2.0'* && "$out" == *'dedup turns=1 ledger=charge:1 ledger=turn:0 no_ledger:0 diff=5.0'* ]] ||
  { echo "FAIL: report lines: $out"; exit 1; }
echo 'ok: refuses without the TEST marker, nothing changed, report printed'

psql_f -c "INSERT INTO supabase_migrations.repo_migrations VALUES ('20261026_checkin_tiered_rewards_test.sql')" >/dev/null
out=$(psql_f <"$align" 2>&1)
[[ "$out" == *'2 TEST turns aligned to their charge amount'* && "$(rates)" == '10.0,5.0,3.0' ]] || { echo "FAIL: align: $out / $(rates)"; exit 1; }
echo 'ok: TEST marker present → turns aligned to the charge amount, consistent turn untouched'

out=$(psql_f <"$expand" 2>&1)
[[ "$out" == *'3 turns in usage_charges; self-check ok'* ]] || { echo "FAIL: expand after align: $out"; exit 1; }
echo 'ok: expand passes its pre-guard and self-check after alignment'

out=$(psql_f <"$align" 2>&1)
[[ "$out" == *'usage_charges already exists; nothing to do'* ]] || { echo "FAIL: rerun: $out"; exit 1; }
echo 'ok: rerun after expand is a no-op'
echo 'all checks passed'
