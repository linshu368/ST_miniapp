#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261120_db_reorg_p6b1a_usage_charges_expand.sql as a NON-superuser:
# - the two llm_usage_charges trigger functions are the production bodies (md5 checked);
# - backfill: turn + charge, turn + dedup only (ledger id found), settled free turn, old unsettled failed turn,
#   in-flight turn (quoted), charge without a turn, dedup key without a turn; self-check ok;
# - mirror after the migration: new turn quoted → charge row → settle → reconcile; free-model failure; the charge
#   row pruned by "keep 100" stays in usage_charges; dedup protection still works;
# - pre-guard refuses when a charge amount differs from deduction_rate (nothing created); rerun is safe.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261120_db_reorg_p6b1a_usage_charges_expand.sql"
task_container="st-db-reorg-p6b1a-${RANDOM}-$$"
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
TRIGGER_FNS_B64='Q1JFQVRFIEZVTkNUSU9OIGJpbGxpbmcucHJlcGFyZV9sbG1fdXNhZ2VfY2hhcmdlKCkgUkVUVVJOUyB0cmlnZ2VyIExBTkdVQUdFIHBscGdzcWwgU0VUIHNlYXJjaF9wYXRoIFRPICdwZ19jYXRhbG9nJyBBUyAkcHJvZGZuJA0KQkVHSU4NCiAgLS0gT25seSBmcmVlLW1vZGVsIGZhaWx1cmVzIGFyZSByZXByZXNlbnRlZCBhcyBmYWlsZWQgc3BlbmRpbmcgZGV0YWlscy4NCiAgLS0gUGFpZCBmYWlsdXJlcyBjb250aW51ZSB0byBwcm9kdWNlIG5vIGNoYXJnZSByb3cuDQogIElGIE5FVy5tb2RlbF9tYXJrdXAgPSAwDQogICAgIEFORCBDT0FMRVNDRShORVcubWV0YWRhdGEgLT4+ICdjaGF0X3N0YXR1cycsICdzdWNjZXNzJykgPD4gJ3N1Y2Nlc3MnIFRIRU4NCiAgICBORVcuc3RhdHVzIDo9ICdmYWlsZWQnOw0KICAgIE5FVy5pbml0aWFsX2Ftb3VudCA6PSAwOw0KICAgIE5FVy5jYWxjdWxhdGVkX2Ftb3VudCA6PSAwOw0KICAgIE5FVy5jaGFyZ2VkX2Ftb3VudCA6PSAwOw0KICAgIE5FVy5mYWxsYmFja191c2VkIDo9IGZhbHNlOw0KICAgIE5FVy5tZXRhZGF0YSA6PSBDT0FMRVNDRShORVcubWV0YWRhdGEsICd7fSc6OkpTT05CKSB8fCBqc29uYl9idWlsZF9vYmplY3QoDQogICAgICAnYmlsbGluZ19tb2RlJywgJ2ZhaWxlZF9mcmVlJywNCiAgICAgICdkaWZmZXJlbmNlX3JlYXNvbicsICdnZW5lcmF0aW9uX2ZhaWxlZCcNCiAgICApOw0KICBFTkQgSUY7DQoNCiAgSUYgRVhJU1RTICgNCiAgICBTRUxFQ1QgMQ0KICAgIEZST00gYmlsbGluZy5sbG1fdXNhZ2VfY2hhcmdlX2RlZHVwIEFTIGRlZHVwDQogICAgV0hFUkUgZGVkdXAuY2hhcmdlX2tleSA9IE5FVy5jaGFyZ2Vfa2V5DQogICAgICAgT1IgKA0KICAgICAgICAgTkVXLmdlbmVyYXRpb25faWQgSVMgTk9UIE5VTEwNCiAgICAgICAgIEFORCBkZWR1cC5nZW5lcmF0aW9uX2lkID0gTkVXLmdlbmVyYXRpb25faWQNCiAgICAgICApDQogICkgVEhFTg0KICAgIFJBSVNFIEVYQ0VQVElPTiAnTExNIHVzYWdlIGNoYXJnZSBhbHJlYWR5IHByb2Nlc3NlZCBhbmQgcHJ1bmVkJw0KICAgICAgVVNJTkcgRVJSQ09ERSA9ICcyMzUwNSc7DQogIEVORCBJRjsNCg0KICBSRVRVUk4gTkVXOw0KRU5EOw0KJHByb2RmbiQ7Cg==
Q1JFQVRFIEZVTkNUSU9OIGJpbGxpbmcucmV0YWluX3JlY2VudF9sbG1fdXNhZ2VfY2hhcmdlcygpIFJFVFVSTlMgdHJpZ2dlciBMQU5HVUFHRSBwbHBnc3FsIFNFVCBzZWFyY2hfcGF0aCBUTyAncGdfY2F0YWxvZycgQVMgJHByb2RmbiQNCkJFR0lODQogIElOU0VSVCBJTlRPIGJpbGxpbmcubGxtX3VzYWdlX2NoYXJnZV9kZWR1cCgNCiAgICBjaGFyZ2Vfa2V5LCBnZW5lcmF0aW9uX2lkLCB1c2VyX2lkLCBjaGFyZ2VkX2Ftb3VudCwgc3RhdHVzLCBwcm9jZXNzZWRfYXQNCiAgKSBWQUxVRVMgKA0KICAgIE5FVy5jaGFyZ2Vfa2V5LA0KICAgIE5FVy5nZW5lcmF0aW9uX2lkLA0KICAgIE5FVy51c2VyX2lkLA0KICAgIE5FVy5jaGFyZ2VkX2Ftb3VudCwNCiAgICBORVcuc3RhdHVzLA0KICAgIE5FVy5jcmVhdGVkX2F0DQogICkNCiAgT04gQ09ORkxJQ1QgKGNoYXJnZV9rZXkpIERPIFVQREFURQ0KICBTRVQgZ2VuZXJhdGlvbl9pZCA9IENPQUxFU0NFKA0KICAgICAgICBiaWxsaW5nLmxsbV91c2FnZV9jaGFyZ2VfZGVkdXAuZ2VuZXJhdGlvbl9pZCwNCiAgICAgICAgRVhDTFVERUQuZ2VuZXJhdGlvbl9pZA0KICAgICAgKSwNCiAgICAgIGNoYXJnZWRfYW1vdW50ID0gRVhDTFVERUQuY2hhcmdlZF9hbW91bnQsDQogICAgICBzdGF0dXMgPSBFWENMVURFRC5zdGF0dXM7DQoNCiAgLS0gUGVuZGluZyByb3dzIGFyZSB0ZW1wb3JhcmlseSByZXRhaW5lZCBldmVuIHdoZW4gb2xkZXIgdGhhbiB0aGUgbGF0ZXN0DQogIC0tIDEwMCBzbyB0aGV5IGNhbiBzZXR0bGUuIFRoZWlyIHJlY29uY2lsaWF0aW9uIHVwZGF0ZSBpbnZva2VzIHRoaXMgdHJpZ2dlcg0KICAtLSBhZ2FpbiBhbmQgbWFrZXMgdGhlbSBlbGlnaWJsZSBmb3IgcHJ1bmluZy4NCiAgREVMRVRFIEZST00gYmlsbGluZy5sbG1fdXNhZ2VfY2hhcmdlcyBBUyBjaGFyZ2UNCiAgV0hFUkUgY2hhcmdlLnVzZXJfaWQgPSBORVcudXNlcl9pZA0KICAgIEFORCBjaGFyZ2Uuc3RhdHVzIDw+ICdwZW5kaW5nJw0KICAgIEFORCBjaGFyZ2UuaWQgSU4gKA0KICAgICAgU0VMRUNUIHJhbmtlZC5pZA0KICAgICAgRlJPTSBiaWxsaW5nLmxsbV91c2FnZV9jaGFyZ2VzIEFTIHJhbmtlZA0KICAgICAgV0hFUkUgcmFua2VkLnVzZXJfaWQgPSBORVcudXNlcl9pZA0KICAgICAgT1JERVIgQlkgcmFua2VkLmNyZWF0ZWRfYXQgREVTQywgcmFua2VkLmlkIERFU0MNCiAgICAgIE9GRlNFVCAxMDANCiAgICApOw0KDQogIFJFVFVSTiBORVc7DQpFTkQ7DQokcHJvZGZuJDsK'
fixture() { # $1 = mismatch to plant a charge amount that differs from deduction_rate
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
  usage_cost_usd numeric(20,10), exchange_rate numeric(14,4) NOT NULL, model_markup numeric(4,1) NOT NULL CHECK (model_markup >= 0),
  initial_amount numeric(14,1) NOT NULL DEFAULT 0, calculated_amount numeric(14,1) NOT NULL DEFAULT 0,
  charged_amount numeric(14,1) NOT NULL DEFAULT 0, fallback_used boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('pending','failed','free','charged','partial','reconciled','historical')),
  debit_ledger_id uuid REFERENCES billing.wallet_ledger(id), metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), reconciled_at timestamptz);
CREATE TABLE billing.llm_usage_charge_dedup (
  charge_key uuid PRIMARY KEY, generation_id text, user_id uuid NOT NULL, charged_amount numeric(14,1) NOT NULL DEFAULT 0,
  status text NOT NULL, processed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE experience.chat_history (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  llm_charge_id uuid, deduction_rate numeric(14,1), llm_billing_snapshot jsonb, llm_intended_deduction numeric(10,2),
  llm_billing_settled_at timestamptz);
SQL
  echo "$TRIGGER_FNS_B64" | head -1 | base64 -d | psql_f >/dev/null
  echo "$TRIGGER_FNS_B64" | tail -1 | base64 -d | psql_f >/dev/null
  psql_f >/dev/null <<'SQL'
CREATE TRIGGER trg_prepare_llm_usage_charge BEFORE INSERT ON billing.llm_usage_charges FOR EACH ROW EXECUTE FUNCTION billing.prepare_llm_usage_charge();
CREATE TRIGGER trg_retain_recent_llm_usage_charges AFTER INSERT OR UPDATE OF status, charged_amount ON billing.llm_usage_charges
  FOR EACH ROW EXECUTE FUNCTION billing.retain_recent_llm_usage_charges();
INSERT INTO app_core.users VALUES ('00000000-0000-0000-00aa-000000000001'), ('00000000-0000-0000-00aa-000000000002');
-- ledger: T1 debit (charge row keeps it), T2 debit (dedup only), D7 debit (dedup key without a turn)
INSERT INTO billing.wallet_ledger (id, user_id, entry_type, amount, reference_type, reference_id) VALUES
  ('00000000-0000-0000-0e00-000000000001', '00000000-0000-0000-00aa-000000000001', 'chat_debit', -10, 'llm_usage', '00000000-0000-0000-0c00-000000000001'),
  ('00000000-0000-0000-0e00-000000000002', '00000000-0000-0000-00aa-000000000001', 'chat_debit', -5, 'llm_usage', '00000000-0000-0000-0c00-000000000002'),
  ('00000000-0000-0000-0e00-000000000007', '00000000-0000-0000-00aa-000000000001', 'chat_debit', -2, 'llm_usage', '00000000-0000-0000-0c00-000000000007');
INSERT INTO experience.chat_history (id, user_id, status, created_at, llm_charge_id, deduction_rate, llm_billing_snapshot, llm_intended_deduction, llm_billing_settled_at) VALUES
  ('00000000-0000-0000-0d00-000000000001', '00000000-0000-0000-00aa-000000000001', 'success', now() - interval '3 days', '00000000-0000-0000-0c00-000000000001', 10, '{"tier":"a"}', 10, now() - interval '3 days'),
  ('00000000-0000-0000-0d00-000000000002', '00000000-0000-0000-00aa-000000000001', 'success', now() - interval '3 days', '00000000-0000-0000-0c00-000000000002', 5, NULL, NULL, NULL),
  ('00000000-0000-0000-0d00-000000000003', '00000000-0000-0000-00aa-000000000001', 'success', now() - interval '3 days', '00000000-0000-0000-0c00-000000000003', 0, '{"tier":"free"}', 0, now() - interval '3 days'),
  ('00000000-0000-0000-0d00-000000000004', '00000000-0000-0000-00aa-000000000001', 'stream_interrupted', now() - interval '2 days', '00000000-0000-0000-0c00-000000000004', NULL, NULL, NULL, NULL),
  ('00000000-0000-0000-0d00-000000000005', '00000000-0000-0000-00aa-000000000001', 'streaming', now(), '00000000-0000-0000-0c00-000000000005', NULL, '{"tier":"a"}', 10, NULL);
INSERT INTO billing.llm_usage_charges (charge_key, user_id, model_openrouter_id, model_display_name, exchange_rate, model_markup, charged_amount, status, debit_ledger_id, created_at) VALUES
  ('00000000-0000-0000-0c00-000000000001', '00000000-0000-0000-00aa-000000000001', 'm/a', 'A', 7, 1, 10, 'charged', '00000000-0000-0000-0e00-000000000001', now() - interval '3 days'),
  ('00000000-0000-0000-0c00-000000000006', '00000000-0000-0000-00aa-000000000002', 'm/h', 'H', 7, 1, 3, 'historical', NULL, now() - interval '120 days');
INSERT INTO billing.llm_usage_charge_dedup (charge_key, user_id, charged_amount, status, processed_at) VALUES
  ('00000000-0000-0000-0c00-000000000002', '00000000-0000-0000-00aa-000000000001', 5, 'charged', now() - interval '3 days'),
  ('00000000-0000-0000-0c00-000000000007', '00000000-0000-0000-00aa-000000000001', 2, 'charged', now() - interval '90 days');
SQL
}
uc() { psql_f -At -c "SELECT status || ':' || charged_credits || ':' || COALESCE(subject_id::text, '-') || ':' || COALESCE(right(debit_ledger_id::text, 1), '-') || ':' || COALESCE(quote ->> 'legacy', '-')
  FROM billing.usage_charges WHERE id = '00000000-0000-0000-0c00-00000000000$1'"; }
expect() { local got; got=$(uc "$1"); [[ "$got" == "$2" ]] || { echo "FAIL: key $1 expected $2 got $got"; exit 1; }; }

fixture
check 'trigger fixtures are the production bodies' <<'SQL'
SELECT array_agg(md5(prosrc) ORDER BY proname) = ARRAY['d666574b326bbe700d09f11a42f152ef', 'f45e4045b64722164e12e9587c388f74']
FROM pg_proc WHERE proname IN ('prepare_llm_usage_charge', 'retain_recent_llm_usage_charges');
SQL
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'orphan charges 1, dedup-only keys 1'* && "$out" == *'5 turns in usage_charges; self-check ok'* ]] ||
  { echo "FAIL: apply output: $out"; exit 1; }
echo 'ok: windowed backfill counts and self-check'
check 'temporary backfill function dropped' <<'SQL'
SELECT NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'p6b1a_backfill_turns');
SQL
expect 1 'charged:10.0:00000000-0000-0000-0d00-000000000001:1:-'
expect 2 'charged:5.0:00000000-0000-0000-0d00-000000000002:2:dedup_only'
expect 3 'free:0.0:00000000-0000-0000-0d00-000000000003:-:-'
expect 4 'failed:0.0:00000000-0000-0000-0d00-000000000004:-:unsettled_no_charge'
expect 5 'quoted:0.0:00000000-0000-0000-0d00-000000000005:-:-'
expect 6 'historical:3.0:-:-:no_turn'
expect 7 'charged:2.0:-:7:dedup_only_no_turn'
echo 'ok: backfill mapping for all seven kinds of keys'
check 'quote keeps snapshot and charge detail; quoted credits; RLS and grants' <<'SQL'
SELECT (SELECT quote -> 'snapshot' = '{"tier":"a"}' AND quote -> 'charge' ->> 'model_display_name' = 'A' AND quoted_credits = 10
        FROM billing.usage_charges WHERE id = '00000000-0000-0000-0c00-000000000001')
  AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'billing.usage_charges'::regclass)
  AND has_table_privilege('service_role', 'billing.usage_charges', 'INSERT');
SQL

# mirror: a new paid turn
psql_f >/dev/null <<'SQL'
INSERT INTO experience.chat_history (id, user_id, status, llm_charge_id, llm_billing_snapshot, llm_intended_deduction)
VALUES ('00000000-0000-0000-0d00-000000000008', '00000000-0000-0000-00aa-000000000002', 'streaming', '00000000-0000-0000-0c00-000000000008', '{"tier":"b"}', 8);
SQL
expect 8 'quoted:0.0:00000000-0000-0000-0d00-000000000008:-:-'
psql_f >/dev/null <<'SQL'
INSERT INTO billing.wallet_ledger (id, user_id, entry_type, amount, reference_type, reference_id)
VALUES ('00000000-0000-0000-0e00-000000000008', '00000000-0000-0000-00aa-000000000002', 'chat_debit', -8, 'llm_usage', '00000000-0000-0000-0c00-000000000008');
INSERT INTO billing.llm_usage_charges (charge_key, user_id, model_openrouter_id, model_display_name, exchange_rate, model_markup, charged_amount, status, debit_ledger_id)
VALUES ('00000000-0000-0000-0c00-000000000008', '00000000-0000-0000-00aa-000000000002', 'm/b', 'B', 7, 1, 8, 'charged', '00000000-0000-0000-0e00-000000000008');
SQL
expect 8 'charged:8.0:00000000-0000-0000-0d00-000000000008:8:-'
psql_f -c "UPDATE experience.chat_history SET status = 'success', deduction_rate = 8, llm_billing_settled_at = now() WHERE id = '00000000-0000-0000-0d00-000000000008'" >/dev/null
psql_f -c "UPDATE billing.llm_usage_charges SET status = 'reconciled', charged_amount = 9, reconciled_at = now() WHERE charge_key = '00000000-0000-0000-0c00-000000000008'" >/dev/null
expect 8 'reconciled:9.0:00000000-0000-0000-0d00-000000000008:8:-'
check 'mirror: settle time, snapshot and charge detail kept together' <<'SQL'
SELECT settled_at IS NOT NULL AND quote -> 'snapshot' = '{"tier":"b"}' AND quote -> 'charge' ->> 'reconciled_at' IS NOT NULL
FROM billing.usage_charges WHERE id = '00000000-0000-0000-0c00-000000000008';
SQL
echo 'ok: mirror follows quoted → charged → reconciled'
# free-model failure: settled, no charge row
psql_f >/dev/null <<'SQL'
INSERT INTO experience.chat_history (id, user_id, status, llm_charge_id, deduction_rate, llm_billing_settled_at)
VALUES ('00000000-0000-0000-0d00-000000000009', '00000000-0000-0000-00aa-000000000002', 'upstream_error', '00000000-0000-0000-0c00-000000000009', 0, now());
SQL
expect 9 'failed:0.0:00000000-0000-0000-0d00-000000000009:-:-'
echo 'ok: settled turn without a charge row is failed'
# "keep 100": 101 more charges for user 1 prune the oldest rows from llm_usage_charges, not from usage_charges
psql_f >/dev/null <<'SQL'
INSERT INTO billing.llm_usage_charges (charge_key, user_id, model_openrouter_id, model_display_name, exchange_rate, model_markup, charged_amount, status)
SELECT gen_random_uuid(), '00000000-0000-0000-00aa-000000000001', 'm/x', 'X', 7, 0, 0, 'free' FROM generate_series(1, 101);
SQL
check 'pruned charge row stays in usage_charges; dedup still blocks a replay' <<'SQL'
SELECT NOT EXISTS (SELECT 1 FROM billing.llm_usage_charges WHERE charge_key = '00000000-0000-0000-0c00-000000000001')
  AND EXISTS (SELECT 1 FROM billing.usage_charges WHERE id = '00000000-0000-0000-0c00-000000000001' AND status = 'charged' AND charged_credits = 10)
  AND (SELECT count(*) FROM billing.usage_charges WHERE user_id = '00000000-0000-0000-00aa-000000000001') = 107;
SQL
if psql_f -c "INSERT INTO billing.llm_usage_charges (charge_key, user_id, model_openrouter_id, model_display_name, exchange_rate, model_markup, status) VALUES ('00000000-0000-0000-0c00-000000000001', '00000000-0000-0000-00aa-000000000001', 'm/a', 'A', 7, 1, 'charged')" >/dev/null 2>&1; then
  echo 'FAIL: replay of a pruned charge was accepted'; exit 1; fi
echo 'ok: replay of a pruned charge is still refused'
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'self-check ok'* ]] || { echo "FAIL: rerun output: $out"; exit 1; }
expect 8 'reconciled:9.0:00000000-0000-0000-0d00-000000000008:8:-'
echo 'ok: rerun keeps mirrored values'

# pre-guard: an old charge that disagrees with deduction_rate → nothing created
fixture
psql_f -c "UPDATE experience.chat_history SET deduction_rate = 11 WHERE id = '00000000-0000-0000-0d00-000000000001'" >/dev/null
if out=$(psql_f <"$migration" 2>&1); then echo 'FAIL: mismatch not refused'; exit 1; fi
[[ "$out" == *'refusing to create usage_charges'* ]] || { echo "FAIL: guard message: $out"; exit 1; }
check 'refusal created nothing' <<'SQL'
SELECT to_regclass('billing.usage_charges') IS NULL
  AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname LIKE 'trg_mirror_%');
SQL
echo 'all checks passed'
