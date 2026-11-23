#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261120_db_reorg_p6b1a_align_test_orphans.sql as a NON-superuser, replaying what happened on TEST:
# - the 6b-1a expand file fails on a dedup key whose user was deleted (FK), after creating the table and backfilling turns;
# - the cleanup refuses without a TEST-only migration in the ledger (nothing deleted);
# - with the TEST marker it removes only that key; rerunning the expand file then passes its self-check;
# - a database without such keys (production shape) is a no-op.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
cleanup="$task_root/packages/shared/migrations/20261120_db_reorg_p6b1a_align_test_orphans.sql"
expand="$task_root/packages/shared/migrations/20261120_db_reorg_p6b1a_usage_charges_expand.sql"
task_container="st-db-reorg-p6b1a-orphans-${RANDOM}-$$"
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
psql_f >/dev/null <<'SQL'
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
INSERT INTO experience.chat_history (id, user_id, status, created_at, llm_charge_id, deduction_rate, llm_billing_settled_at) VALUES
  ('00000000-0000-0000-0d00-000000000001', '00000000-0000-0000-00aa-000000000001', 'success', now() - interval '3 days', '00000000-0000-0000-0c00-000000000001', 0, now() - interval '3 days');
-- one dedup key of a live user without a turn, one of a deleted user (no FK on the dedup table)
INSERT INTO billing.llm_usage_charge_dedup (charge_key, user_id, charged_amount, status, processed_at) VALUES
  ('00000000-0000-0000-0c00-000000000002', '00000000-0000-0000-00aa-000000000001', 0, 'free', now() - interval '90 days'),
  ('00000000-0000-0000-0c00-000000000003', '00000000-0000-0000-00aa-0000000000ff', 4, 'charged', now() - interval '100 days');
SQL

if out=$(psql_f <"$expand" 2>&1); then echo "FAIL: expand should hit the FK first: $out"; exit 1; fi
[[ "$out" == *'usage_charges_user_id_fkey'* ]] || { echo "FAIL: expected FK error: $out"; exit 1; }
check 'TEST replay: table and turn backfill landed before the FK failure' <<'SQL'
SELECT to_regclass('billing.usage_charges') IS NOT NULL AND (SELECT count(*) FROM billing.usage_charges) = 1;
SQL

if out=$(psql_f <"$cleanup" 2>&1); then echo "FAIL: refusal expected without TEST marker: $out"; exit 1; fi
[[ "$out" == *'1 dedup keys of deleted users on a database without TEST-only migrations; refusing'* &&
  "$out" == *'charged keys=1 amount=4.0'* ]] || { echo "FAIL: refusal output: $out"; exit 1; }
check 'refusal deleted nothing' <<'SQL'
SELECT count(*) = 2 FROM billing.llm_usage_charge_dedup;
SQL

psql_f -c "INSERT INTO supabase_migrations.repo_migrations VALUES ('20261117_media_plaza_stream_test_assets.sql')" >/dev/null
out=$(psql_f <"$cleanup" 2>&1)
[[ "$out" == *'1 TEST dedup keys of deleted users removed'* ]] || { echo "FAIL: cleanup output: $out"; exit 1; }
check 'only the deleted user key removed' <<'SQL'
SELECT array_agg(right(charge_key::text, 1) ORDER BY charge_key) = ARRAY['2'] FROM billing.llm_usage_charge_dedup;
SQL

out=$(psql_f <"$expand" 2>&1)
[[ "$out" == *'orphan charges 0, dedup-only keys 1'* && "$out" == *'1 turns in usage_charges; self-check ok'* ]] ||
  { echo "FAIL: expand rerun: $out"; exit 1; }
echo 'ok: expand rerun passes after the cleanup'

out=$(psql_f <"$cleanup" 2>&1)
[[ "$out" == *'no dedup keys of deleted users; nothing to do'* ]] || { echo "FAIL: no-op: $out"; exit 1; }
echo 'ok: production shape (no such keys) is a no-op'
echo 'all checks passed'
