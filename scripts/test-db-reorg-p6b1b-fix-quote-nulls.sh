#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261121_db_reorg_p6b1b_fix_quote_nulls.sql as a NON-superuser:
# - reproduces the 6b-1a defect (run the real 6b-1a expand file: null snapshot / charge keys get stripped);
# - after the fix quote.snapshot equals chat_history.llm_billing_snapshot and quote.charge equals the charge row, null keys included;
# - the patched mirror keeps null keys on later updates; rerun is a no-op; a drifted mirror function is refused.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
expand="$task_root/packages/shared/migrations/20261120_db_reorg_p6b1a_usage_charges_expand.sql"
migration="$task_root/packages/shared/migrations/20261121_db_reorg_p6b1b_fix_quote_nulls.sql"
task_container="st-db-reorg-p6b1b-quote-${RANDOM}-$$"
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
setup() {
  psql_f >/dev/null <<'SQL'
DROP SCHEMA IF EXISTS app_core, billing, experience CASCADE;
CREATE SCHEMA app_core; CREATE SCHEMA billing; CREATE SCHEMA experience;
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
INSERT INTO experience.chat_history (id, user_id, status, created_at, llm_charge_id, deduction_rate, llm_billing_snapshot, llm_billing_settled_at) VALUES
  ('00000000-0000-0000-0d00-000000000001', '00000000-0000-0000-00aa-000000000001', 'success', now() - interval '3 days', '00000000-0000-0000-0c00-000000000001', 10,
   '{"charge_id":"00000000-0000-0000-0c00-000000000001","payable_credits":10,"discount_rate":null,"vip_valid_until":null}', now() - interval '3 days'),
  ('00000000-0000-0000-0d00-000000000002', '00000000-0000-0000-00aa-000000000001', 'success', now() - interval '120 days', '00000000-0000-0000-0c00-000000000002', 0,
   '{"charge_id":"00000000-0000-0000-0c00-000000000002","payable_credits":0,"discount_rate":0.95,"vip_valid_until":null}', now() - interval '120 days'),
  ('00000000-0000-0000-0d00-000000000003', '00000000-0000-0000-00aa-000000000001', 'streaming', now(), '00000000-0000-0000-0c00-000000000003', NULL,
   '{"charge_id":"00000000-0000-0000-0c00-000000000003","payable_credits":12,"discount_rate":null,"vip_valid_until":null}', NULL);
INSERT INTO billing.llm_usage_charges (charge_key, user_id, model_openrouter_id, model_display_name, exchange_rate, model_markup, charged_amount, status, created_at) VALUES
  ('00000000-0000-0000-0c00-000000000001', '00000000-0000-0000-00aa-000000000001', 'm/a', 'A', 1, 1, 10, 'charged', now() - interval '3 days');
SQL
  psql_f <"$expand" >/dev/null 2>&1
}
setup
check '6b-1a stripped the null keys (defect reproduced)' <<'SQL'
SELECT NOT ((SELECT quote -> 'snapshot' FROM billing.usage_charges WHERE id = '00000000-0000-0000-0c00-000000000001') ? 'discount_rate')
   AND NOT ((SELECT quote -> 'charge' FROM billing.usage_charges WHERE id = '00000000-0000-0000-0c00-000000000001') ? 'reconciled_at')
   AND (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'tf_mirror_chat_history_charge') = 'e92dcad757394429b6b0d2b9ff134917';
SQL
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'mirror trigger now keeps null snapshot keys'* && "$out" == *'match their sources row by row'* ]] || { echo "FAIL: apply: $out"; exit 1; }
echo 'ok: applied'
check 'snapshots equal chat_history and charge details equal the charge row, null keys included' <<'SQL'
SELECT NOT EXISTS (SELECT 1 FROM experience.chat_history h JOIN billing.usage_charges u ON u.id = h.llm_charge_id
                   WHERE (u.quote -> 'snapshot') IS DISTINCT FROM h.llm_billing_snapshot)
   AND (SELECT (quote -> 'charge') ? 'reconciled_at' AND (quote -> 'charge') ? 'model_id' FROM billing.usage_charges
        WHERE id = '00000000-0000-0000-0c00-000000000001')
   AND (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'tf_mirror_chat_history_charge') = '1a1616a61ba4f3b42a032f08d7b8132a'
   AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'p6b1b_fix_quote');
SQL
check 'patched mirror keeps null keys on a later settlement update' <<'SQL'
UPDATE experience.chat_history SET llm_billing_snapshot = llm_billing_snapshot || '{"provider":"openrouter"}', llm_billing_settled_at = now(), deduction_rate = 12
WHERE id = '00000000-0000-0000-0d00-000000000003';
SELECT (quote -> 'snapshot') = (SELECT llm_billing_snapshot FROM experience.chat_history WHERE id = '00000000-0000-0000-0d00-000000000003')
   AND (quote -> 'snapshot') ? 'vip_valid_until'
FROM billing.usage_charges WHERE id = '00000000-0000-0000-0c00-000000000003';
SQL
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'already keeps null snapshot keys'* && "$out" == *'snapshots 0, charges 0'* && "$out" != *'snapshots 1'* ]] || { echo "FAIL: rerun: $out"; exit 1; }
echo 'ok: rerun is a no-op'
setup
psql_f -c "CREATE OR REPLACE FUNCTION billing.tf_mirror_chat_history_charge() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN RETURN NULL; END \$\$" >/dev/null
if out=$(psql_f <"$migration" 2>&1); then echo "FAIL: drift should refuse"; exit 1; fi
[[ "$out" == *'tf_mirror_chat_history_charge drifted'* ]] || { echo "FAIL: drift message: $out"; exit 1; }
echo 'ok: a drifted mirror function is refused'
echo 'all checks passed'
