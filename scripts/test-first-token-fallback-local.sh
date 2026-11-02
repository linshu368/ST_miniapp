#!/usr/bin/env bash
# Synthetic local PG17 only. No remote URL, application environment, or provider calls.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="st-first-token-test-$$"
task_rest_container="$task_container-rest"
task_network="$task_container-net"
task_dir="$(mktemp -d /tmp/st-first-token-test.XXXXXX)"
task_dir="$(cd "$task_dir" && pwd -P)"
cleanup() { docker rm -f "$task_rest_container" "$task_container" >/dev/null 2>&1 || true; docker network rm "$task_network" >/dev/null 2>&1 || true; rm -rf -- "$task_dir"; }
trap cleanup EXIT
docker network create "$task_network" >/dev/null
docker run --rm -d --network "$task_network" --name "$task_container" -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$task_root:$task_root:ro" -v "$task_dir:$task_dir:ro" postgres:17 >/dev/null
for task_n in {1..120}; do
  if docker exec "$task_container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 0.25
done
task_psql=(docker exec -i "$task_container" psql -X -U postgres -v ON_ERROR_STOP=1)
"${task_psql[@]}" -f "$task_root/scripts/openrouter-retirement-bootstrap.sql" >/dev/null
"${task_psql[@]}" >/dev/null <<'SQL'
ALTER ROLE service_role BYPASSRLS;
CREATE SCHEMA admin;
CREATE SCHEMA app_core;
CREATE TABLE app_core.runtime_config(key text,value jsonb);
CREATE TABLE admin.config_drafts(config_key text,value jsonb);
CREATE TABLE admin.config_releases(config_key text,value jsonb);
SQL
for task_file in 20260929_llm_model_catalog_multi_provider.sql 20260929_venice_chat_history.sql 20261015_openrouter_chat_history.sql 20261023_chat_first_token_fallback.sql; do
  "${task_psql[@]}" -f "$task_root/packages/shared/migrations/$task_file" >/dev/null
done
# An additive rerun must preserve IDs, OIDs, grants, and the delivery contract.
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261023_chat_first_token_fallback.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261023_chat_first_token_fallback_config.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261023_chat_first_token_fallback_config.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261026_first_token_stage_budgets.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261026_first_token_stage_budgets.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/tests/chat_first_token_fallback.sql" >/dev/null
"${task_psql[@]}" -c 'CREATE ROLE grafana_cloud LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS' >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261023_grafana_first_token_reader.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261023_grafana_first_token_reader.sql" >/dev/null
"${task_psql[@]}" -c 'GRANT SELECT(user_input) ON experience.chat_history TO grafana_cloud' >/dev/null
if "${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261023_grafana_first_token_reader.sql" >"$task_dir/grant-drift.log" 2>&1; then
  echo 'FAIL: unexpected existing content grant was accepted' >&2
  exit 1
fi
"${task_psql[@]}" -c 'REVOKE SELECT(user_input) ON experience.chat_history FROM grafana_cloud' >/dev/null
"${task_psql[@]}" >/dev/null <<'SQL'
SET ROLE first_token_metrics_reader;
SELECT count(*) FROM miniapp_analytics.chat_first_token_facts;
SELECT count(*) FROM miniapp_analytics.chat_first_token_report('2026-10-22 00:00:00+08','2026-10-23 00:00:00+08');
RESET ROLE;
SET ROLE grafana_cloud;
SELECT count(*) FROM miniapp_analytics.chat_first_token_facts;
SELECT count(*) FROM miniapp_analytics.chat_first_token_report('2026-10-22 00:00:00+08','2026-10-23 00:00:00+08');
DO $$ BEGIN
 BEGIN
  PERFORM user_input FROM experience.chat_history LIMIT 1;
  RAISE EXCEPTION 'Grafana can read conversation content';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  UPDATE experience.chat_generation_requests SET client_outcome='missing' WHERE false;
  RAISE EXCEPTION 'Grafana can mutate observations';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
DO $$ BEGIN
 IF has_column_privilege('first_token_metrics_reader','experience.chat_history','user_input','SELECT')
 OR has_column_privilege('first_token_metrics_reader','experience.chat_history','assistant_reply','SELECT')
 OR has_function_privilege('first_token_metrics_reader','experience.report_chat_first_token(uuid,uuid,jsonb)','EXECUTE')
 OR has_function_privilege('grafana_cloud','experience.report_chat_first_token(uuid,uuid,jsonb)','EXECUTE')
 OR has_column_privilege('grafana_cloud','experience.chat_history','assistant_reply','SELECT')
 THEN RAISE EXCEPTION 'Metrics role can read content or mutate reports'; END IF;
END $$;
SQL
# Production PostgREST retries serialization_failure indefinitely; permanent guards
# must return a terminal HTTP conflict while preserving the existing lifecycle CAS.
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261026_first_token_nonretryable_conflicts.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261026_first_token_nonretryable_conflicts.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261028_first_token_race.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261028_first_token_race.sql" >/dev/null

# Supabase repositories through real PostgREST; only the API port is mapped to loopback.
docker run --rm -d --network "$task_network" --name "$task_rest_container" \
  -e PGRST_DB_URI="postgres://postgres@$task_container:5432/postgres" \
  -e GHCRTS="-N1" -e PGRST_DB_SCHEMAS="experience,miniapp_analytics" -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="first-token-local-fixture-only-jwt-secret-at-least-32-characters" \
  -p 127.0.0.1::3000 postgrest/postgrest:v12.2.12 >/dev/null
task_rest_port="$(docker port "$task_rest_container" 3000/tcp)"
task_rest_port="${task_rest_port##*:}"
for task_n in {1..120}; do
  if curl --silent --fail "http://127.0.0.1:$task_rest_port/" >/dev/null; then break; fi
  sleep 0.25
done

# Extend this disposable observation DB with real wallet/quota primitives.
# The earlier bootstrap deliberately has skeletal billing tables; no remote DB is used.
"${task_psql[@]}" >/dev/null <<'SQL'
DROP TABLE billing.llm_usage_charge_dedup;
DROP TABLE billing.llm_usage_charges;
DROP TABLE billing.character_free_chat_quota_decisions;
ALTER TABLE app_core.runtime_config ADD PRIMARY KEY (key);
ALTER TABLE app_core.runtime_config ADD COLUMN description text, ADD COLUMN version integer DEFAULT 1,
  ADD COLUMN updated_at timestamptz DEFAULT now(), ADD COLUMN text_value text;
CREATE TABLE app_core.characters(id uuid PRIMARY KEY);
SQL
for task_file in fixtures/vip_billing_t2_harness.sql 20260924_vip_billing_schema_pg_cron_compat.sql 20260921_wallet_debit_refund.sql tests/vip_llm_t4_setup.sql 20260922_llm_vip_wallet_charge.sql; do
  "${task_psql[@]}" -f "$task_root/packages/shared/migrations/$task_file" >/dev/null
done
# Apply the original quota definition with the schema split's canonical names.
python3 - "$task_root" <<'PYQUOTA' | "${task_psql[@]}" >/dev/null
import pathlib,sys
s=(pathlib.Path(sys.argv[1])/'packages/shared/migrations/055_character_free_chat_quota.sql').read_text()
s=s[:s.index('-- Populate deduct_markup')]+ '\nCOMMIT;\n'
print(s.replace('miniapp.users','app_core.users').replace('miniapp.characters','app_core.characters').replace('miniapp.','billing.'))
PYQUOTA
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261026_first_token_visible_billing.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261026_first_token_visible_billing.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261026_first_token_receipt_quota_release.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261026_first_token_receipt_quota_release.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/tests/vip_llm_t4_scenarios.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/tests/first_token_visible_billing.sql" >/dev/null
# Race a committed timeout receipt against a settlement from another connection.
"${task_psql[@]}" -c "BEGIN; SELECT visible_billing_test.report('00000000-0000-4000-8000-000000000091','timed_out'); SELECT pg_sleep(0.5); COMMIT;" >/dev/null &
task_report_pid=$!
"${task_psql[@]}" -c "SELECT visible_billing_test.charge('00000000-0000-4000-8000-000000000091');" >/dev/null &
task_charge_pid=$!
wait "$task_report_pid"
wait "$task_charge_pid"
"${task_psql[@]}" -c "SELECT visible_billing_test.charge('00000000-0000-4000-8000-000000000091'); SELECT vip_t4_test.assert(NOT EXISTS(SELECT 1 FROM billing.wallet_ledger WHERE debit_key='00000000-0000-4000-8000-000000000091'),'concurrent no-token timeout was charged');" >/dev/null
echo 'PASS: visible token receipt, zero debit/quota on timeout/missing, late replay and concurrent settlement'

# Explicit user stops are a new persisted reason; legacy/system outcomes stay free.
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261026_user_stop_billing.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261026_user_stop_billing.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/tests/user_stop_billing.sql" >/dev/null
"${task_psql[@]}" -c "SELECT user_stop_test.charge('00000000-0000-4000-8000-0000000001ab');" >/dev/null &
task_stop_first_pid=$!
"${task_psql[@]}" -c "SELECT user_stop_test.charge('00000000-0000-4000-8000-0000000001ab');" >/dev/null &
task_stop_second_pid=$!
wait "$task_stop_first_pid"
wait "$task_stop_second_pid"
"${task_psql[@]}" -c "SELECT vip_t4_test.assert((SELECT count(*)=1 AND sum(abs(amount))=29 FROM billing.wallet_ledger WHERE debit_key='00000000-0000-4000-8000-0000000001ab'),'concurrent user stop double debit');" >/dev/null
echo 'PASS: explicit stop original quote/entitlement once; system timeout and legacy cancellations stay free'

# Recoverable delivery: additive migration, old policy preserved, once-only billing.
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261027_recoverable_chat_delivery.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261027_recoverable_chat_delivery.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261028_client_committed_first_token.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261028_client_committed_first_token.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261029_first_token_receipt_recovery.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261029_first_token_receipt_recovery.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/tests/recoverable_chat_delivery.sql" >/dev/null
echo 'PASS: recoverable/v4 commit delivery, immutable receipt, cutoff/quota, departure and original user-stop price'
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261030_chat_generation_dispatch_prepare.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261030_chat_generation_dispatch_prepare.sql" >/dev/null
# Standalone PostgREST's fixture role needs the same narrow quota lookup used by a cutoff receipt.
"${task_psql[@]}" -c 'GRANT USAGE ON SCHEMA billing TO service_role; GRANT SELECT ON billing.character_free_chat_quota_decisions TO service_role;' >/dev/null
FIRST_TOKEN_TEST_REST_URL="http://127.0.0.1:$task_rest_port" DOTENV_CONFIG_PATH=/dev/null \
  pnpm --dir "$task_root" --filter @miniapp/backend exec vitest run src/infrastructure/repositories/GenerationObservationRepository.integration.test.ts

# Competing database transactions must still bind exactly one provider identity.
"${task_psql[@]}" -c "SELECT recoverable_test.race_claim('00000000-0000-4000-8000-0000000002d2','primary',true);" >"$task_dir/race-primary.log" &
task_race_primary_pid=$!
"${task_psql[@]}" -c "SELECT recoverable_test.race_claim('00000000-0000-4000-8000-0000000002d2','fallback',true);" >"$task_dir/race-fallback.log" &
task_race_fallback_pid=$!
wait "$task_race_primary_pid"
wait "$task_race_fallback_pid"
"${task_psql[@]}" -c "SELECT recoverable_test.race_finish('00000000-0000-4000-8000-0000000002d2');" >/dev/null
"${task_psql[@]}" -c "SELECT visible_billing_test.charge('00000000-0000-4000-8000-0000000002d2');" >/dev/null &
task_race_first_charge_pid=$!
"${task_psql[@]}" -c "SELECT visible_billing_test.charge('00000000-0000-4000-8000-0000000002d2');" >/dev/null &
task_race_second_charge_pid=$!
wait "$task_race_first_charge_pid"
wait "$task_race_second_charge_pid"
"${task_psql[@]}" -c "SELECT vip_t4_test.assert((SELECT count(*)=1 AND sum(abs(amount))=30 FROM billing.wallet_ledger WHERE debit_key='00000000-0000-4000-8000-0000000002d2'),'racing attempts caused duplicate debit');" >/dev/null
echo 'PASS: primary may win after fallback, concurrent winner CAS, loser privacy and once-only debit'

# Install the real retention/dedup contract in this disposable billing fixture.
python3 - "$task_root" <<'PYRETENTION' | "${task_psql[@]}" >/dev/null
import pathlib,sys
print((pathlib.Path(sys.argv[1])/'packages/shared/migrations/053_llm_spending_retention.sql').read_text().replace('miniapp.','billing.'))
PYRETENTION
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261028_llm_archived_charge_result.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261028_llm_archived_charge_result.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/tests/llm_archived_charge_result.sql" >/dev/null
echo 'PASS: real detail retention, permanent dedup replay, pending gate and unknown conflict rollback'

# Creator ownership is the only core dependency used by billing. Full CRUD/access
# and version migrations have their own core suite; do not copy their runtime here.
"${task_psql[@]}" -c 'CREATE TABLE app_core.character_creations(character_id uuid PRIMARY KEY REFERENCES app_core.characters(id),owner_user_id uuid NOT NULL REFERENCES app_core.users(id));' >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261030_character_creator_rewards.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261030_character_creator_rewards.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/tests/character_creator_rewards.sql" >/dev/null
# Both directions acquire the two wallets in the same order, including retries.
"${task_psql[@]}" -c "SELECT creator_reward_test.charge('90000000-0000-4000-8000-000000000110','90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000002',10);" >/dev/null &
task_creator_first_pid=$!
"${task_psql[@]}" -c "SELECT creator_reward_test.charge('90000000-0000-4000-8000-000000000111','90000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000001',10);" >/dev/null &
task_creator_second_pid=$!
"${task_psql[@]}" -c "SELECT creator_reward_test.charge('90000000-0000-4000-8000-000000000110','90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000002',10);" >/dev/null &
task_creator_retry_pid=$!
wait "$task_creator_first_pid"
wait "$task_creator_second_pid"
wait "$task_creator_retry_pid"
"${task_psql[@]}" -c "SELECT creator_reward_test.assert((SELECT count(*)=2 FROM billing.character_creator_rewards WHERE charge_key IN ('90000000-0000-4000-8000-000000000110','90000000-0000-4000-8000-000000000111')),'concurrent duplicate or missing reward');" >/dev/null
echo 'PASS: creator actual-debit 40 percent, zero/self exclusion, frozen replay, refund debt, offset and concurrent dedup'

# Pure monitoring no longer reads Supabase. Guard the retired entry and new sources.
python3 - "$task_root" <<'PYDASHBOARD'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]);old=json.loads((root/'docs/grafana/chat-first-token.json').read_text())
assert not old.get('refresh') and not old.get('__inputs')
assert not old['templating']['list']
assert all(not p.get('targets') for p in old['panels']), 'Retired board still queries Supabase'
new=json.loads((root/'docs/grafana/st-engineering-roleplay.json').read_text())
assert {101,102,103,104,105,106}.issubset({p['id'] for p in new['panels']})
for p in new['panels']:
 for t in p.get('targets',[]):
  assert 'rawSql' not in t and t['datasource']['type'] in ('loki','prometheus')
print('PASS: retired first-token board has no SQL/refresh; replacement reads only Loki/Metrics')
PYDASHBOARD
echo 'PASS: first-token SQL business identity, delivery CAS, frozen quote, reporting ACL and immutable receipt'

# Run the existing real wallet/free-quota migration suite in another disposable DB.
mkdir "$task_dir/bin"
for task_command in psql createdb dropdb; do
  cat >"$task_dir/bin/$task_command" <<EOF
#!/usr/bin/env bash
exec docker exec -i "$task_container" "$task_command" -U postgres "\$@"
EOF
  chmod +x "$task_dir/bin/$task_command"
done
PATH="$task_dir/bin:$PATH" bash "$task_root/scripts/test-vip-billing-migrations.sh"

PATH="$task_dir/bin:$PATH" TMPDIR="$task_dir" bash "$task_root/scripts/apply-repo-migration.test.sh"
