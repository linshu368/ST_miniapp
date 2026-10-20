#!/usr/bin/env bash
# Opt-in isolated PG17 + real PostgREST; no remote credentials or application env files.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_pg_bin="${OPENROUTER_TEST_PG_BIN:-$(pg_config --bindir)}"
task_rest_bin="${OPENROUTER_TEST_POSTGREST_BIN:?Set a local PostgREST executable path}"
task_dir="$(mktemp -d /tmp/openrouter-retirement.XXXXXX)"
task_rest_pid=''
cleanup() {
 if [[ -n "$task_rest_pid" ]]; then kill "$task_rest_pid" 2>/dev/null || true; fi
 "$task_pg_bin/pg_ctl" -D "$task_dir/data" -m fast -w stop >/dev/null 2>&1 || true
 case "$task_dir" in /tmp/openrouter-retirement.*) rm -rf -- "$task_dir" ;; esac
}
trap cleanup EXIT
# Ephemeral loopback ports; PostgREST and PG never bind public interfaces.
read -r task_pg_port task_rest_port < <(python3 - <<'PY'
import socket
sockets=[socket.socket(),socket.socket()]
for sock in sockets: sock.bind(('127.0.0.1',0))
print(*(sock.getsockname()[1] for sock in sockets))
for sock in sockets: sock.close()
PY
)
"$task_pg_bin/initdb" -D "$task_dir/data" -U postgres --auth=trust --encoding=UTF8 --locale=C >"$task_dir/init.log"
"$task_pg_bin/pg_ctl" -D "$task_dir/data" -l "$task_dir/pg.log" -o "-k $task_dir -p $task_pg_port -c listen_addresses=127.0.0.1" -w start >/dev/null
task_psql=("$task_pg_bin/psql" -X -h "$task_dir" -p "$task_pg_port" -U postgres -d postgres -v ON_ERROR_STOP=1)
task_sql="$task_root/packages/shared/migrations"
task_history_file=20261020_openrouter_history_disposition_recovery.sql
task_drop_file=20261020_chat_history_drop_provider_metadata_bounded_guards.sql
"${task_psql[@]}" -f "$task_root/scripts/openrouter-retirement-bootstrap.sql" >/dev/null
"${task_psql[@]}" -f "$task_sql/20260929_venice_chat_history.sql" >/dev/null
"${task_psql[@]}" -c "INSERT INTO experience.venice_chat_history(chat_history_id,llm_generation_id,llm_latency,llm_usage) VALUES('00000000-0000-0000-0000-000000000002','venice-fixture',7,'0'); GRANT SELECT ON experience.venice_chat_history TO cs_persona_reader;" >/dev/null
for task_file in 20261015_openrouter_chat_history.sql 20261015_openrouter_chat_history_backfill.sql 20261015_openrouter_chat_history_venice_exclusion_backfill.sql 20261016_openrouter_original_metadata_fields.sql; do
 "${task_psql[@]}" -f "$task_sql/$task_file" >/dev/null
done
# A valid missing historical identity, a proven no-ID scalar, and an unknown no-ID scalar.
"${task_psql[@]}" -c "DELETE FROM experience.openrouter_chat_history WHERE chat_history_id='00000000-0000-0000-0000-000000000001'; CREATE TABLE experience.view_shape AS SELECT attname,atttypid,atttypmod,attnum FROM pg_attribute WHERE attrelid='experience.current_chat_history'::regclass AND attnum>0;" >/dev/null
expect_reject() {
 if "${task_psql[@]}" -f "$task_sql/$task_drop_file" >"$task_dir/reject.log" 2>&1; then
  echo 'FAIL: premature DROP was accepted' >&2; exit 1
 fi
 rg -q "$1" "$task_dir/reject.log"
}
expect_reject 'Legacy column database dependency remains'
# Forward recovery must cover a real second batch and reject unsafe/oversize inputs atomically.
expect_catchup_reject() {
 if "${task_psql[@]}" -f "$task_sql/20261020_openrouter_retirement_catchup_recovery.sql" >"$task_dir/catchup-reject.log" 2>&1; then
  echo "FAIL: unsafe catch-up recovery accepted ($1)" >&2; exit 1
 fi
 rg -q "$1" "$task_dir/catchup-reject.log"
}
"${task_psql[@]}" >/dev/null <<'SQL'
INSERT INTO experience.chat_history(model,llm_generation_id)
SELECT 'recovery-budget-fixture','budget-'||n FROM generate_series(1,4001) n;
SQL
expect_catchup_reject 'Catch-up recovery exceeds reviewed two-batch 4000-row budget'
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM experience.openrouter_chat_history o JOIN experience.chat_history h ON h.id=o.chat_history_id WHERE h.model='recovery-budget-fixture') THEN RAISE EXCEPTION 'oversize recovery leaked writes'; END IF;
END $$;
DELETE FROM experience.chat_history WHERE model='recovery-budget-fixture';
INSERT INTO experience.openrouter_chat_history(chat_history_id,llm_generation_id) VALUES('00000000-0000-0000-0000-000000000001','wrong-call');
SQL
expect_catchup_reject 'OpenRouter identity conflict'
"${task_psql[@]}" -c "DELETE FROM experience.openrouter_chat_history WHERE chat_history_id='00000000-0000-0000-0000-000000000001'; INSERT INTO experience.openrouter_chat_history(chat_history_id) VALUES('00000000-0000-0000-0000-000000000002');" >/dev/null
expect_catchup_reject 'Provider overlap'
"${task_psql[@]}" -c "DELETE FROM experience.openrouter_chat_history WHERE chat_history_id='00000000-0000-0000-0000-000000000002'; UPDATE experience.chat_history SET llm_billing_snapshot='{\"provider\":\"venice\"}' WHERE id='00000000-0000-0000-0000-000000000004';" >/dev/null
expect_catchup_reject 'Venice snapshot without Venice detail'
"${task_psql[@]}" >/dev/null <<'SQL'
UPDATE experience.chat_history SET llm_billing_snapshot=NULL WHERE id='00000000-0000-0000-0000-000000000004';
INSERT INTO experience.chat_history(id,model,llm_generation_id,llm_usage,llm_native_tokens_prompt)
SELECT ('10000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'recovery-batch-fixture','batch-'||n,'0',0 FROM generate_series(1,2815) n;
CREATE TABLE experience.catchup_parent_before AS TABLE experience.chat_history;
CREATE TABLE experience.catchup_detail_before AS TABLE experience.openrouter_chat_history;
CREATE FUNCTION experience.catchup_second_batch_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.chat_history_id='10000000-0000-0000-0000-000000002815' THEN RAISE EXCEPTION 'synthetic second batch failure'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER catchup_second_batch_failure BEFORE INSERT ON experience.openrouter_chat_history FOR EACH ROW EXECUTE FUNCTION experience.catchup_second_batch_failure();
SQL
expect_catchup_reject 'synthetic second batch failure'
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
 IF EXISTS (SELECT * FROM experience.openrouter_chat_history EXCEPT SELECT * FROM experience.catchup_detail_before) OR EXISTS (SELECT * FROM experience.catchup_detail_before EXCEPT SELECT * FROM experience.openrouter_chat_history) THEN RAISE EXCEPTION 'second batch failure leaked first batch'; END IF;
END $$;
DROP TRIGGER catchup_second_batch_failure ON experience.openrouter_chat_history;
DROP FUNCTION experience.catchup_second_batch_failure();
SQL
"${task_psql[@]}" -f "$task_sql/20261020_openrouter_retirement_catchup_recovery.sql" >/dev/null
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
 IF (SELECT count(*) FROM experience.openrouter_chat_history o JOIN experience.chat_history h ON h.id=o.chat_history_id WHERE h.model='recovery-batch-fixture' AND o.llm_generation_id=h.llm_generation_id AND o.usage='0' AND o.native_tokens_prompt=0)<>2815 THEN RAISE EXCEPTION 'recovery lost second batch or zero facts'; END IF;
 IF EXISTS (SELECT * FROM experience.chat_history EXCEPT SELECT * FROM experience.catchup_parent_before) OR EXISTS (SELECT * FROM experience.catchup_parent_before EXCEPT SELECT * FROM experience.chat_history) THEN RAISE EXCEPTION 'recovery changed parent business facts'; END IF;
 IF EXISTS (SELECT 1 FROM experience.openrouter_chat_history WHERE chat_history_id='00000000-0000-0000-0000-000000000004') THEN RAISE EXCEPTION 'recovery guessed unknown provider'; END IF;
END $$;
DROP TABLE experience.catchup_parent_before,experience.catchup_detail_before;
DELETE FROM experience.chat_history WHERE model='recovery-batch-fixture';
UPDATE experience.openrouter_chat_history SET provider_name='current-vendor',usage='2',latency=NULL WHERE chat_history_id='00000000-0000-0000-0000-000000000001';
SQL
# Re-entry keeps newer non-NULL facts even when another scalar is still missing.
"${task_psql[@]}" -f "$task_sql/20261020_openrouter_retirement_catchup_recovery.sql" >/dev/null
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM experience.openrouter_chat_history WHERE chat_history_id='00000000-0000-0000-0000-000000000001' AND provider_name='current-vendor' AND usage='2' AND latency=0) THEN RAISE EXCEPTION 're-entry replaced canonical facts'; END IF;
END $$;
UPDATE experience.openrouter_chat_history SET provider_name='Google',usage='0' WHERE chat_history_id='00000000-0000-0000-0000-000000000001';
SQL

"${task_psql[@]}" -f "$task_sql/20261016_openrouter_retirement_catchup.sql" >/dev/null
"${task_psql[@]}" -f "$task_sql/20261016_chat_history_provider_metadata_views.sql" >/dev/null
expect_reject 'Unpreserved identity/scalars'
# The provider contract is independent of the parent contract's historical gates.
expect_alias_reject() {
 if "${task_psql[@]}" -f "$task_sql/20261016_openrouter_chat_history_drop_legacy_aliases.sql" >"$task_dir/alias-reject.log" 2>&1; then
  echo "FAIL: unsafe alias DROP was accepted ($1)" >&2; exit 1
 fi
 rg -q "$1" "$task_dir/alias-reject.log"
}
# The production-only Grafana schema is absent in TEST; never create it there.
"${task_psql[@]}" -f "$task_sql/20261020_grafana_provider_metadata_dependencies.sql" >/dev/null
expect_grafana_reject() {
 if "${task_psql[@]}" -f "$task_sql/20261020_grafana_provider_metadata_dependencies.sql" >"$task_dir/grafana-reject.log" 2>&1; then
  echo "FAIL: unsafe Grafana repair accepted ($1)" >&2; exit 1
 fi
 rg -q "$1" "$task_dir/grafana-reject.log"
}
"${task_psql[@]}" -c 'CREATE SCHEMA analytics_grafana;' >/dev/null
expect_grafana_reject 'Grafana provider repair requires all five known objects'
"${task_psql[@]}" -c 'DROP SCHEMA analytics_grafana;' >/dev/null
"${task_psql[@]}" -f "$task_root/scripts/openrouter-grafana-retirement-fixture.sql" >/dev/null
expect_alias_reject 'OpenRouter alias database dependency remains'
"${task_psql[@]}" -c "INSERT INTO experience.openrouter_chat_history(chat_history_id) VALUES('00000000-0000-0000-0000-000000000002');" >/dev/null
expect_grafana_reject 'Grafana provider overlap'
"${task_psql[@]}" -c "DELETE FROM experience.openrouter_chat_history WHERE chat_history_id='00000000-0000-0000-0000-000000000002'; UPDATE experience.openrouter_chat_history SET usage='9',llm_usage='0' WHERE chat_history_id='00000000-0000-0000-0000-000000000001';" >/dev/null
expect_grafana_reject 'Conflicting Grafana alias/canonical facts'
"${task_psql[@]}" -c "UPDATE experience.openrouter_chat_history SET usage='0' WHERE chat_history_id='00000000-0000-0000-0000-000000000001';" >/dev/null
"${task_psql[@]}" >/dev/null <<'SQL'
CREATE TABLE experience.grafana_old_definitions AS SELECT c.oid,c.relname,pg_get_viewdef(c.oid,true) AS definition
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='analytics_grafana' AND c.relkind IN ('v','m');
DO $$ DECLARE original text; BEGIN
 SELECT definition INTO original FROM experience.grafana_old_definitions WHERE relname='v_llm_calls';
 EXECUTE 'CREATE OR REPLACE VIEW analytics_grafana.v_llm_calls AS SELECT * FROM ('||rtrim(original,';')||') drift WHERE false';
END $$;
SQL
expect_grafana_reject 'Grafana definition drift'
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
 EXECUTE 'CREATE OR REPLACE VIEW analytics_grafana.v_llm_calls AS '||(SELECT definition FROM experience.grafana_old_definitions WHERE relname='v_llm_calls');
END $$;
CREATE VIEW analytics_grafana.unknown_mat_dependent AS SELECT * FROM analytics_grafana.mv_free_quota_daily;
SQL
expect_grafana_reject 'Unknown Grafana materialized-view dependent'
"${task_psql[@]}" >/dev/null <<'SQL'
DROP VIEW analytics_grafana.unknown_mat_dependent;
INSERT INTO experience.chat_history(model) SELECT 'grafana-budget-fixture' FROM generate_series(1,2001);
INSERT INTO experience.openrouter_chat_history(chat_history_id,llm_native_tokens_cached)
 SELECT id,0 FROM experience.chat_history WHERE model='grafana-budget-fixture';
SQL
expect_grafana_reject 'Grafana alias catch-up exceeds reviewed 2000-row budget'
"${task_psql[@]}" >/dev/null <<'SQL'
DELETE FROM experience.chat_history WHERE model='grafana-budget-fixture';
UPDATE experience.openrouter_chat_history SET llm_native_tokens_cached=0,native_tokens_cached=NULL
 WHERE chat_history_id='00000000-0000-0000-0000-000000000001';
CREATE FUNCTION experience.fail_second_grafana_stage() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN
 IF current_query() LIKE '%mv_free_quota_daily_or_new%' THEN RAISE EXCEPTION 'synthetic second Grafana MV build failure'; END IF;
END $$;
CREATE EVENT TRIGGER fail_second_grafana_stage ON ddl_command_start WHEN TAG IN ('CREATE MATERIALIZED VIEW')
 EXECUTE FUNCTION experience.fail_second_grafana_stage();
SQL
expect_grafana_reject 'synthetic second Grafana MV build failure'
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM experience.openrouter_chat_history WHERE chat_history_id='00000000-0000-0000-0000-000000000001' AND native_tokens_cached IS NOT NULL)
 OR to_regclass('analytics_grafana.mv_card_unit_economics_30d_or_new') IS NOT NULL
 OR EXISTS (SELECT 1 FROM experience.grafana_old_definitions d WHERE to_regclass('analytics_grafana.'||d.relname) IS DISTINCT FROM d.oid)
 THEN RAISE EXCEPTION 'failed Grafana repair leaked writes or object changes'; END IF;
END $$;
DROP EVENT TRIGGER fail_second_grafana_stage;
DROP FUNCTION experience.fail_second_grafana_stage();
CREATE FUNCTION experience.change_grafana_during_stage() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN
 IF current_query() LIKE '%mv_free_quota_daily_or_new%' THEN
  COMMENT ON MATERIALIZED VIEW analytics_grafana.mv_free_quota_daily IS 'synthetic metadata race';
 END IF;
END $$;
CREATE EVENT TRIGGER change_grafana_during_stage ON ddl_command_end WHEN TAG IN ('CREATE MATERIALIZED VIEW')
 EXECUTE FUNCTION experience.change_grafana_during_stage();
SQL
expect_grafana_reject 'Grafana definition changed during staging'
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
 IF obj_description('analytics_grafana.mv_free_quota_daily'::regclass) IS NOT NULL
 OR to_regclass('analytics_grafana.mv_free_quota_daily_or_new') IS NOT NULL
 THEN RAISE EXCEPTION 'Grafana staging metadata race did not roll back'; END IF;
END $$;
DROP EVENT TRIGGER change_grafana_during_stage;
DROP FUNCTION experience.change_grafana_during_stage();
-- The replacement MVs must revoke default grants that the old objects never had.
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics_grafana GRANT SELECT ON TABLES TO anon;
UPDATE experience.venice_chat_history SET llm_usage='1000000' WHERE chat_history_id='00000000-0000-0000-0000-000000000002';
INSERT INTO experience.chat_history(id,turn_index,status,llm_generation_id,llm_usage,llm_finish_reason,character_id,llm_charge_id)
 VALUES('00000000-0000-0000-0000-000000000070',70,'success','grafana-paid-fixture','1.25','stop','00000000-0000-0000-0000-000000000080','00000000-0000-0000-0000-000000000270');
INSERT INTO experience.openrouter_chat_history(chat_history_id,llm_generation_id,usage,llm_usage)
 VALUES('00000000-0000-0000-0000-000000000070','grafana-paid-fixture','1.25','1.25');
INSERT INTO billing.wallet_ledger VALUES('00000000-0000-0000-0000-000000000270',-115,-80,-35,'llm_usage','chat_debit');
INSERT INTO billing.payment_orders VALUES('00000000-0000-0000-0000-000000000099','completed',now()-interval '1 day');
INSERT INTO billing.character_free_chat_quota_decisions(charge_key,status,user_id,character_id,granted_free)
 VALUES('00000000-0000-0000-0000-000000000270','consumed','00000000-0000-0000-0000-000000000099','00000000-0000-0000-0000-000000000080',true);
CREATE TABLE experience.grafana_parent_before AS TABLE experience.chat_history;
CREATE TABLE experience.grafana_billing_before AS TABLE billing.llm_usage_charges;
CREATE TABLE experience.grafana_shape_before AS SELECT c.relname,
 (SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnum) ORDER BY a.attnum)
  FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='analytics_grafana';
SQL
"${task_psql[@]}" -f "$task_sql/20261020_grafana_provider_metadata_dependencies.sql" >/dev/null
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
 IF EXISTS (SELECT * FROM experience.chat_history EXCEPT SELECT * FROM experience.grafana_parent_before)
 OR EXISTS (SELECT * FROM experience.grafana_parent_before EXCEPT SELECT * FROM experience.chat_history)
 OR EXISTS (SELECT * FROM billing.llm_usage_charges EXCEPT SELECT * FROM experience.grafana_billing_before)
 THEN RAISE EXCEPTION 'Grafana repair changed parent/billing facts'; END IF;
 IF EXISTS (SELECT 1 FROM experience.grafana_shape_before d JOIN pg_class c ON c.oid=to_regclass('analytics_grafana.'||d.relname)
 WHERE d.columns IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnum) ORDER BY a.attnum)
  FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped))
 THEN RAISE EXCEPTION 'Grafana output shape changed'; END IF;
 IF EXISTS (SELECT 1 FROM experience.grafana_old_definitions d WHERE d.relname NOT IN ('mv_free_quota_daily','mv_card_unit_economics_30d')
 AND to_regclass('analytics_grafana.'||d.relname) IS DISTINCT FROM d.oid) THEN RAISE EXCEPTION 'Grafana downstream OID changed'; END IF;
 IF NOT has_table_privilege('grafana_cloud','analytics_grafana.v_card_unit_economics_30d','SELECT')
 OR NOT has_table_privilege('grafana_reader','analytics_grafana.v_llm_calls','SELECT')
 OR has_table_privilege('anon','analytics_grafana.mv_free_quota_daily','SELECT')
 OR has_table_privilege('authenticated','analytics_grafana.v_llm_calls','SELECT')
 THEN RAISE EXCEPTION 'Grafana reader grants changed or broadened'; END IF;
 IF (SELECT count(*) FROM pg_indexes WHERE schemaname='analytics_grafana' AND indexname IN ('mv_free_quota_daily_uidx','mv_card_unit_economics_30d_character_label_idx'))<>2
 THEN RAISE EXCEPTION 'Grafana refresh unique index missing'; END IF;
 IF NOT EXISTS (SELECT 1 FROM analytics_grafana.v_llm_calls WHERE platform='openrouter' AND real_cost_usd=0 AND cached_tokens=0 AND finish_reason='cancelled' AND NOT is_clean_success)
 THEN RAISE EXCEPTION 'Grafana zero/terminal facts changed'; END IF;
 IF NOT EXISTS (SELECT 1 FROM analytics_grafana.v_llm_calls WHERE platform='venice' AND real_cost_usd=1 AND real_cost_cny=7 AND latency_ms=7)
 OR NOT EXISTS (SELECT 1 FROM analytics_grafana.v_llm_calls WHERE platform='openrouter' AND real_cost_usd=1.25 AND real_cost_cny=8.75 AND stars_total=115 AND main_stars=80 AND bonus_stars=35 AND wallet_value_proxy_cny=1)
 OR NOT EXISTS (SELECT 1 FROM analytics_grafana.mv_free_quota_daily WHERE cost_cny=8.75 AND decision_rows=1 AND matched_chat_rows=1)
 THEN RAISE EXCEPTION 'Grafana provider cost/currency or wallet/quota formulas changed'; END IF;
END $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics_grafana REVOKE SELECT ON TABLES FROM anon;
REFRESH MATERIALIZED VIEW CONCURRENTLY analytics_grafana.mv_free_quota_daily;
REFRESH MATERIALIZED VIEW CONCURRENTLY analytics_grafana.mv_card_unit_economics_30d;
REFRESH MATERIALIZED VIEW CONCURRENTLY analytics_grafana.mv_strategy_downstream_fixture;
SET ROLE grafana_reader;
SELECT * FROM analytics_grafana.v_llm_calls;
SELECT * FROM analytics_grafana.v_card_downstream_fixture;
SELECT * FROM analytics_grafana.v_free_quota_daily;
RESET ROLE;
DROP TABLE experience.grafana_parent_before,experience.grafana_billing_before,experience.grafana_shape_before,experience.grafana_old_definitions;
DELETE FROM experience.chat_history WHERE id='00000000-0000-0000-0000-000000000070';
DELETE FROM billing.wallet_ledger;
DELETE FROM billing.payment_orders;
DELETE FROM billing.character_free_chat_quota_decisions WHERE charge_key='00000000-0000-0000-0000-000000000270';
UPDATE experience.venice_chat_history SET llm_usage='0' WHERE chat_history_id='00000000-0000-0000-0000-000000000002';
SQL
# Re-entry is harmless even after a committed SQL transaction whose ledger record was interrupted.
"${task_psql[@]}" -f "$task_sql/20261020_grafana_provider_metadata_dependencies.sql" >/dev/null

"${task_psql[@]}" -c "CREATE VIEW experience.alias_dependency_fixture AS SELECT llm_usage FROM experience.openrouter_chat_history;" >/dev/null
expect_alias_reject 'OpenRouter alias database dependency remains'
"${task_psql[@]}" -c "DROP VIEW experience.alias_dependency_fixture; UPDATE experience.openrouter_chat_history SET usage='1',llm_usage='0' WHERE chat_history_id='00000000-0000-0000-0000-000000000001';" >/dev/null
expect_alias_reject 'Conflicting OpenRouter alias/canonical facts'
"${task_psql[@]}" -c "UPDATE experience.openrouter_chat_history SET usage=llm_usage WHERE llm_usage IS NOT NULL; ALTER TABLE experience.openrouter_chat_history ADD CONSTRAINT fixture_mixed_check CHECK(llm_usage IS NULL OR usage IS NULL OR usage=llm_usage);" >/dev/null
expect_alias_reject 'OpenRouter alias database dependency remains'
"${task_psql[@]}" -c "ALTER TABLE experience.openrouter_chat_history DROP CONSTRAINT fixture_mixed_check; INSERT INTO experience.chat_history(model) SELECT 'alias-budget-fixture' FROM generate_series(1,2001); INSERT INTO experience.openrouter_chat_history(chat_history_id,llm_model) SELECT id,'budget-model' FROM experience.chat_history WHERE model='alias-budget-fixture';" >/dev/null
expect_alias_reject 'OpenRouter alias catch-up exceeds reviewed 2000-row budget'
"${task_psql[@]}" -c "DELETE FROM experience.chat_history WHERE model='alias-budget-fixture'; UPDATE experience.openrouter_chat_history SET llm_generation_data='{\"usage\":0}',llm_provider_name='AliasVendor',provider_name=NULL,llm_finish_reason='stop',finish_reason=NULL,llm_model='legacy-fixture-model',model=NULL,usage=NULL,llm_usage_cache='0',usage_cache=NULL,llm_native_tokens_cached=0,native_tokens_cached=NULL,llm_native_tokens_reasoning=0,native_tokens_reasoning=NULL,llm_native_tokens_completion=0,native_tokens_completion=NULL,llm_native_tokens_prompt=0,native_tokens_prompt=NULL,llm_latency=0,latency=NULL,llm_generation_time=0,generation_time=NULL WHERE chat_history_id='00000000-0000-0000-0000-000000000001'; CREATE TABLE experience.parent_before_alias_drop AS SELECT * FROM experience.chat_history;" >/dev/null
"${task_psql[@]}" -f "$task_sql/20261016_openrouter_chat_history_drop_legacy_aliases.sql" >/dev/null
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
 IF EXISTS (SELECT * FROM experience.chat_history EXCEPT SELECT * FROM experience.parent_before_alias_drop) OR EXISTS (SELECT * FROM experience.parent_before_alias_drop EXCEPT SELECT * FROM experience.chat_history) THEN RAISE EXCEPTION 'alias contract changed parent facts'; END IF;
 IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='experience.openrouter_chat_history'::regclass AND NOT attisdropped AND left(attname,4)='llm_' AND attname NOT IN ('llm_generation_id','llm_generation_data')) THEN RAISE EXCEPTION 'legacy aliases remain'; END IF;
 IF NOT EXISTS (SELECT 1 FROM experience.openrouter_chat_history WHERE chat_history_id='00000000-0000-0000-0000-000000000001' AND provider_name='AliasVendor' AND finish_reason='stop' AND model='legacy-fixture-model' AND usage='0' AND usage_cache='0' AND native_tokens_cached=0 AND native_tokens_reasoning=0 AND native_tokens_completion=0 AND native_tokens_prompt=0 AND latency=0 AND generation_time=0 AND llm_generation_id='or-fixture' AND llm_generation_data='{"usage":0}'::jsonb) THEN RAISE EXCEPTION 'alias scalar/zero/identity not preserved'; END IF;
 BEGIN
  UPDATE experience.openrouter_chat_history SET native_tokens_prompt=-1;
  RAISE EXCEPTION 'canonical negative tokens accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
END $$;
DROP TABLE experience.parent_before_alias_drop;
SET ROLE cs_persona_reader;
SELECT * FROM experience.current_chat_history;
SELECT * FROM miniapp_analytics.base_chat_bj;
RESET ROLE;
SQL
expect_alias_reject 'Unexpected OpenRouter alias/canonical shape'
# Synthetic-only audit resolution: a fixture supplies reliable attribution, never done remotely.
"${task_psql[@]}" -c "UPDATE experience.chat_history SET llm_billing_snapshot='{\"provider\":\"openrouter\"}' WHERE id='00000000-0000-0000-0000-000000000004';" >/dev/null
"${task_psql[@]}" -f "$task_sql/20261016_openrouter_retirement_catchup.sql" >/dev/null
"${task_psql[@]}" -c "UPDATE experience.chat_history SET llm_generation_data='{\"prompt\":\"synthetic-only\"}' WHERE id='00000000-0000-0000-0000-000000000004';" >/dev/null
expect_reject 'Legacy diagnostic JSON requires'
# History disposal preserves controlled facts while discarding sensitive extras.
expect_disposition_reject() {
 if "${task_psql[@]}" -f "$task_sql/$task_history_file" >"$task_dir/history-reject.log" 2>&1; then
  echo "FAIL: unsafe historical disposition accepted ($1)" >&2; exit 1
 fi
 rg -q "$1" "$task_dir/history-reject.log"
}
"${task_psql[@]}" -c "UPDATE experience.chat_history SET llm_generation_data='[]' WHERE id='00000000-0000-0000-0000-000000000004';" >/dev/null
expect_disposition_reject 'Unresolved historical JSON shape/provider/identity'
"${task_psql[@]}" -c "UPDATE experience.chat_history SET llm_generation_data=jsonb_build_object('model',repeat('x',513)) WHERE id='00000000-0000-0000-0000-000000000004';" >/dev/null
expect_disposition_reject 'Oversized historical metadata string'
"${task_psql[@]}" -c "UPDATE experience.chat_history SET llm_generation_data='{}' WHERE id='00000000-0000-0000-0000-000000000004'; INSERT INTO experience.venice_chat_history(chat_history_id) VALUES('00000000-0000-0000-0000-000000000004');" >/dev/null
expect_disposition_reject 'Unresolved historical JSON shape/provider/identity'
"${task_psql[@]}" -c "DELETE FROM experience.venice_chat_history WHERE chat_history_id='00000000-0000-0000-0000-000000000004'; UPDATE experience.chat_history SET llm_generation_data='{\"model\":\"VeniceModel\",\"finish_reason\":\"stop\"}' WHERE id='00000000-0000-0000-0000-000000000002';" >/dev/null
expect_disposition_reject 'Unpreserved Venice historical JSON fact'
"${task_psql[@]}" -c "UPDATE experience.venice_chat_history SET llm_model='VeniceModel',llm_finish_reason='stop' WHERE chat_history_id='00000000-0000-0000-0000-000000000002';" >/dev/null
"${task_psql[@]}" >/dev/null <<'SQL'
UPDATE experience.chat_history SET llm_generation_data='{"id":"wrong-call"}' WHERE id='00000000-0000-0000-0000-000000000001';
UPDATE experience.chat_history SET llm_generation_data='{"usage":0,"native_tokens_reasoning":3,"finish_reason":"stop","error":{"code":429,"message":"synthetic secret"},"external_user":"synthetic-only","provider_responses":{"prompt":"synthetic-only"}}' WHERE id='00000000-0000-0000-0000-000000000004';
SQL
expect_disposition_reject 'Unresolved historical JSON shape/provider/identity'
"${task_psql[@]}" >/dev/null <<'SQL'
UPDATE experience.chat_history SET llm_generation_data='{"id":"or-fixture","usage":9,"finish_reason":"stop","prompt":"synthetic-only"}' WHERE id='00000000-0000-0000-0000-000000000001';
UPDATE experience.openrouter_chat_history SET llm_generation_data='{"usage":0,"headers":{"authorization":"synthetic-only"},"error":{"code":500,"message":"synthetic-only"}}' WHERE chat_history_id='00000000-0000-0000-0000-000000000001';
INSERT INTO experience.chat_history(model,llm_generation_data) SELECT 'history-budget-fixture','{}'::jsonb FROM generate_series(1,2001);
SQL
task_history_file=20261016_openrouter_history_disposition.sql
expect_disposition_reject 'History disposition exceeds reviewed 2000-row budget'
task_history_file=20261020_openrouter_history_disposition_recovery.sql
"${task_psql[@]}" -c "DELETE FROM experience.chat_history WHERE model='history-budget-fixture'; CREATE TABLE experience.parent_before_history AS SELECT id,user_input,assistant_reply,history,status,llm_finish_reason,llm_charge_id,llm_billing_snapshot,llm_billing_settled_at FROM experience.chat_history;" >/dev/null
# Inject a competing rewrite at the final parent clear to verify CAS rollback.
"${task_psql[@]}" >/dev/null <<'SQL'
CREATE FUNCTION experience.disposition_race_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.llm_generation_data IS NULL AND OLD.llm_generation_data IS NOT NULL THEN NEW.llm_generation_data='{"changed":true}'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER disposition_race_fixture BEFORE UPDATE OF llm_generation_data ON experience.chat_history FOR EACH ROW EXECUTE FUNCTION experience.disposition_race_fixture();
SQL
expect_disposition_reject 'Historical JSON changed during disposition'
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM experience.chat_history WHERE id='00000000-0000-0000-0000-000000000004' AND llm_generation_data ? 'external_user') OR EXISTS (SELECT 1 FROM experience.openrouter_chat_history WHERE chat_history_id='00000000-0000-0000-0000-000000000004' AND native_tokens_reasoning IS NOT NULL) THEN RAISE EXCEPTION 'failed disposition leaked writes'; END IF;
END $$;
DROP TRIGGER disposition_race_fixture ON experience.chat_history;
DROP FUNCTION experience.disposition_race_fixture();
SQL
"${task_psql[@]}" -f "$task_sql/$task_history_file" >/dev/null
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM experience.chat_history WHERE llm_generation_data IS NOT NULL) THEN RAISE EXCEPTION 'raw diagnostics remain'; END IF;
 IF EXISTS (SELECT id,user_input,assistant_reply,history,status,llm_finish_reason,llm_charge_id,llm_billing_snapshot,llm_billing_settled_at FROM experience.chat_history EXCEPT SELECT * FROM experience.parent_before_history) THEN RAISE EXCEPTION 'history disposal changed business facts'; END IF;
 IF NOT EXISTS (SELECT 1 FROM experience.openrouter_chat_history WHERE chat_history_id='00000000-0000-0000-0000-000000000004' AND usage='0' AND native_tokens_reasoning=3 AND finish_reason='stop' AND llm_generation_data->'error'='{"code":429}'::jsonb AND NOT llm_generation_data ?| ARRAY['external_user','provider_responses']) THEN RAISE EXCEPTION 'whitelist facts not preserved'; END IF;
 IF (SELECT usage FROM experience.openrouter_chat_history WHERE chat_history_id='00000000-0000-0000-0000-000000000001')<>'0' THEN RAISE EXCEPTION 'old JSON replaced canonical fact'; END IF;
 IF NOT EXISTS (SELECT 1 FROM experience.openrouter_chat_history WHERE chat_history_id='00000000-0000-0000-0000-000000000001' AND llm_generation_data='{"usage":0,"error":{"code":500}}'::jsonb) THEN RAISE EXCEPTION 'existing unsafe detail diagnostic not normalized'; END IF;
END $$;
DROP TABLE experience.parent_before_history;
SQL
# Multiple independently committed batches: failure preserves earlier progress and rolls back only the failing batch.
"${task_psql[@]}" >/dev/null <<'SQL'
INSERT INTO experience.chat_history(id,model,llm_generation_data)
SELECT ('f0000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 'disposition-recovery-fixture','{"usage":0,"finish_reason":"stop","external_user":"synthetic-only"}'::jsonb
FROM generate_series(1,300001) n;
SQL
expect_disposition_reject 'History disposition recovery exceeds 300000-row budget'
"${task_psql[@]}" >/dev/null <<'SQL'
DELETE FROM experience.chat_history WHERE model='disposition-recovery-fixture' AND id>'f0000000-0000-0000-0000-000000006001';
INSERT INTO experience.openrouter_chat_history(chat_history_id,llm_generation_data)
SELECT id,'{"usage":0,"headers":{"authorization":"synthetic-only"}}'::jsonb
FROM experience.chat_history WHERE model='disposition-recovery-fixture';
CREATE TABLE experience.disposition_parent_before AS TABLE experience.chat_history;
CREATE TABLE experience.disposition_detail_before AS TABLE experience.openrouter_chat_history;
CREATE FUNCTION experience.disposition_second_batch_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.id='f0000000-0000-0000-0000-000000006001' THEN RAISE EXCEPTION 'synthetic history last batch failure'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER disposition_second_batch_failure BEFORE UPDATE OF llm_generation_data ON experience.chat_history
 FOR EACH ROW EXECUTE FUNCTION experience.disposition_second_batch_failure();
SQL
expect_disposition_reject 'synthetic history last batch failure'
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM experience.chat_history WHERE id='f0000000-0000-0000-0000-000000000001' AND llm_generation_data IS NOT NULL)
 OR NOT EXISTS (SELECT 1 FROM experience.openrouter_chat_history WHERE chat_history_id='f0000000-0000-0000-0000-000000000001' AND usage='0')
 OR NOT EXISTS (SELECT 1 FROM experience.chat_history WHERE id='f0000000-0000-0000-0000-000000006001' AND llm_generation_data IS NOT NULL)
 OR EXISTS (SELECT 1 FROM experience.openrouter_chat_history WHERE chat_history_id='f0000000-0000-0000-0000-000000006001' AND usage IS NOT NULL)
 THEN RAISE EXCEPTION 'disposition batch progress/rollback violated'; END IF;
END $$;
DROP TRIGGER disposition_second_batch_failure ON experience.chat_history;
DROP FUNCTION experience.disposition_second_batch_failure();
SQL
"${task_psql[@]}" -f "$task_sql/$task_history_file" >/dev/null
# Re-entry must visit the fixed manifest once, including already normalized provider JSON.
"${task_psql[@]}" -c "CREATE TABLE experience.disposition_updated_before AS SELECT chat_history_id,updated_at FROM experience.openrouter_chat_history;" >/dev/null
"${task_psql[@]}" -f "$task_sql/$task_history_file" >/dev/null
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
 IF EXISTS (SELECT chat_history_id,updated_at FROM experience.openrouter_chat_history EXCEPT SELECT * FROM experience.disposition_updated_before) THEN RAISE EXCEPTION 're-entry rewrote normalized provider rows'; END IF;
 IF EXISTS (SELECT 1 FROM experience.chat_history WHERE llm_generation_data IS NOT NULL)
 OR (SELECT count(*) FROM experience.openrouter_chat_history o JOIN experience.chat_history h ON h.id=o.chat_history_id
 WHERE h.model='disposition-recovery-fixture' AND o.usage='0' AND o.finish_reason='stop'
 AND o.llm_generation_data='{"usage":0}'::jsonb)<>6001
 THEN RAISE EXCEPTION 'disposition recovery lost second batch, zeros, or whitelist'; END IF;
 IF EXISTS (SELECT id,user_input,assistant_reply,history,status,llm_finish_reason,llm_charge_id,llm_billing_snapshot,llm_billing_settled_at FROM experience.chat_history
 EXCEPT SELECT id,user_input,assistant_reply,history,status,llm_finish_reason,llm_charge_id,llm_billing_snapshot,llm_billing_settled_at FROM experience.disposition_parent_before)
 THEN RAISE EXCEPTION 'disposition recovery changed business facts'; END IF;
END $$;
DELETE FROM experience.chat_history WHERE model='disposition-recovery-fixture';
DROP TABLE experience.disposition_parent_before, experience.disposition_detail_before, experience.disposition_updated_before;
SQL
expect_reject 'Reviewed history disposition must be applied and recorded first'
"${task_psql[@]}" -c "INSERT INTO supabase_migrations.repo_migrations(filename,checksum) VALUES('20261020_openrouter_history_disposition_recovery.sql','drift');" >/dev/null
expect_reject 'Reviewed history disposition must be applied and recorded first'
task_history_checksum="$(shasum -a 256 "$task_sql/$task_history_file" | cut -d ' ' -f 1)"
"${task_psql[@]}" -c "UPDATE supabase_migrations.repo_migrations SET checksum='$task_history_checksum' WHERE filename='$task_history_file';" >/dev/null

"${task_psql[@]}" -c "UPDATE experience.chat_history SET llm_charge_id='00000000-0000-0000-0000-000000000201' WHERE id='00000000-0000-0000-0000-000000000001';" >/dev/null
expect_reject 'Historical billing/quota closure not proven'
# Synthetic-only closure of the fixture's legacy accounting, without any real wallet.
"${task_psql[@]}" -c "UPDATE experience.chat_history SET llm_billing_settled_at=now() WHERE id='00000000-0000-0000-0000-000000000001'; INSERT INTO experience.chat_history(id,llm_charge_id) VALUES('00000000-0000-0000-0000-000000000050','00000000-0000-0000-0000-000000000250'); INSERT INTO experience.openrouter_chat_history(chat_history_id) VALUES('00000000-0000-0000-0000-000000000050');" >/dev/null
"${task_psql[@]}" >/dev/null <<'SQL'
INSERT INTO experience.chat_history(id,turn_index,created_at,status,llm_generation_id,llm_charge_id) SELECT ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,n,'2026-08-01','success','history-'||n,('00000000-0000-0000-0000-'||lpad((n+200)::text,12,'0'))::uuid FROM generate_series(40,43) n;
UPDATE experience.chat_history SET status='upstream_error' WHERE id='00000000-0000-0000-0000-000000000042';
INSERT INTO experience.openrouter_chat_history(chat_history_id,llm_generation_id) SELECT id,llm_generation_id FROM experience.chat_history WHERE turn_index BETWEEN 40 AND 43;
INSERT INTO billing.llm_usage_charges(charge_key,generation_id,user_id,status,charged_amount) SELECT llm_charge_id,llm_generation_id,user_id,CASE WHEN turn_index=43 THEN 'pending' ELSE 'charged' END,CASE WHEN turn_index=43 THEN 0 ELSE 5 END FROM experience.chat_history WHERE turn_index IN (40,43);
INSERT INTO billing.llm_usage_charge_dedup SELECT * FROM billing.llm_usage_charges;
INSERT INTO billing.llm_usage_charge_dedup SELECT llm_charge_id,llm_generation_id,user_id,'free',0 FROM experience.chat_history WHERE turn_index=41;
INSERT INTO billing.character_free_chat_quota_decisions VALUES('00000000-0000-0000-0000-000000000240','reserved'),('00000000-0000-0000-0000-000000000250','reserved');
SQL
expect_reject 'Historical billing/quota closure not proven'
"${task_psql[@]}" -c "UPDATE billing.character_free_chat_quota_decisions SET status='consumed' WHERE charge_key='00000000-0000-0000-0000-000000000240'; UPDATE experience.chat_history SET created_at=now() WHERE turn_index=41;" >/dev/null
expect_reject 'Historical billing/quota closure not proven'
"${task_psql[@]}" -c "UPDATE experience.chat_history SET created_at='2026-08-01' WHERE turn_index=41; UPDATE billing.llm_usage_charge_dedup SET user_id='00000000-0000-0000-0000-000000000098' WHERE charge_key='00000000-0000-0000-0000-000000000241';" >/dev/null
expect_reject 'Historical billing/quota closure not proven'
"${task_psql[@]}" -c "UPDATE billing.llm_usage_charge_dedup SET user_id='00000000-0000-0000-0000-000000000099' WHERE charge_key='00000000-0000-0000-0000-000000000241'; DELETE FROM billing.llm_usage_charge_dedup WHERE charge_key='00000000-0000-0000-0000-000000000241';" >/dev/null
expect_reject 'Historical billing/quota closure not proven'
"${task_psql[@]}" -c "INSERT INTO billing.llm_usage_charge_dedup SELECT llm_charge_id,llm_generation_id,user_id,'free',0 FROM experience.chat_history WHERE turn_index=41; UPDATE experience.chat_history SET llm_billing_snapshot='{}' WHERE turn_index=43;" >/dev/null
expect_reject 'Historical billing/quota closure not proven'
"${task_psql[@]}" -c "UPDATE experience.chat_history SET llm_billing_snapshot=NULL WHERE turn_index=43; UPDATE billing.llm_usage_charge_dedup SET status='charged' WHERE charge_key='00000000-0000-0000-0000-000000000243';" >/dev/null
expect_reject 'Historical billing/quota closure not proven'
"${task_psql[@]}" -c "UPDATE billing.llm_usage_charge_dedup SET status='pending' WHERE charge_key='00000000-0000-0000-0000-000000000243'; UPDATE supabase_migrations.repo_migrations SET checksum='drift' WHERE filename='20260911_chat_history_billing_settlement.sql';" >/dev/null
expect_reject 'Billing schema boundary ledger missing or drifted'
"${task_psql[@]}" -c "UPDATE supabase_migrations.repo_migrations SET checksum='f32b5fcec327217bd6591066d1f7e1c758f8b9e372cda3adbc08b6758bf7e9ea' WHERE filename='20260911_chat_history_billing_settlement.sql'; CREATE TABLE billing.charges_before AS TABLE billing.llm_usage_charges; CREATE TABLE billing.dedup_before AS TABLE billing.llm_usage_charge_dedup; CREATE TABLE billing.quota_before AS TABLE billing.character_free_chat_quota_decisions;" >/dev/null
"${task_psql[@]}" -f "$task_sql/$task_drop_file" >/dev/null
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
 IF EXISTS (SELECT * FROM billing.llm_usage_charges EXCEPT SELECT * FROM billing.charges_before) OR EXISTS (SELECT * FROM billing.charges_before EXCEPT SELECT * FROM billing.llm_usage_charges) THEN RAISE EXCEPTION 'charges changed'; END IF;
 IF EXISTS (SELECT * FROM billing.llm_usage_charge_dedup EXCEPT SELECT * FROM billing.dedup_before) OR EXISTS (SELECT * FROM billing.dedup_before EXCEPT SELECT * FROM billing.llm_usage_charge_dedup) THEN RAISE EXCEPTION 'dedup changed'; END IF;
 IF EXISTS (SELECT * FROM billing.character_free_chat_quota_decisions EXCEPT SELECT * FROM billing.quota_before) OR EXISTS (SELECT * FROM billing.quota_before EXCEPT SELECT * FROM billing.character_free_chat_quota_decisions) THEN RAISE EXCEPTION 'quota changed'; END IF;
 IF NOT EXISTS (SELECT 1 FROM experience.chat_history WHERE turn_index=43 AND llm_billing_settled_at IS NULL) OR NOT EXISTS (SELECT 1 FROM billing.llm_usage_charges WHERE status='pending') THEN RAISE EXCEPTION 'old pending was fabricated as settled'; END IF;
END $$;
DELETE FROM experience.chat_history WHERE turn_index BETWEEN 40 AND 43;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM experience.chat_history WHERE id='00000000-0000-0000-0000-000000000050' AND status='streaming' AND llm_charge_id IS NOT NULL) THEN RAISE EXCEPTION 'healthy active call was changed'; END IF;
END $$;
DELETE FROM experience.chat_history WHERE id='00000000-0000-0000-0000-000000000050';
DO $$ BEGIN
 IF EXISTS (SELECT * FROM experience.view_shape EXCEPT SELECT attname,atttypid,atttypmod,attnum FROM pg_attribute WHERE attrelid='experience.current_chat_history'::regclass AND attnum>0) THEN RAISE EXCEPTION 'view shape changed'; END IF;
 IF NOT (SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class WHERE oid='experience.current_chat_history'::regclass) THEN RAISE EXCEPTION 'invoker mode lost'; END IF;
 IF (SELECT count(*) FROM experience.current_chat_history)<>4 OR (SELECT count(*) FROM miniapp_analytics.base_chat_bj)<>4 THEN RAISE EXCEPTION 'view cardinality changed'; END IF;
 IF (SELECT llm_latency FROM miniapp_analytics.base_chat_bj WHERE id='00000000-0000-0000-0000-000000000002')<>7 THEN RAISE EXCEPTION 'Venice latency misrouted'; END IF;
 IF (SELECT llm_finish_reason FROM experience.current_chat_history WHERE id='00000000-0000-0000-0000-000000000001')<>'cancelled' THEN RAISE EXCEPTION 'business finish changed'; END IF;
 IF has_table_privilege('cs_persona_reader','experience.openrouter_chat_history','SELECT') THEN RAISE EXCEPTION 'reader was given entire table'; END IF;
 IF has_any_column_privilege('anon','experience.openrouter_chat_history','SELECT') OR has_any_column_privilege('authenticated','experience.openrouter_chat_history','SELECT') THEN RAISE EXCEPTION 'public metadata grant'; END IF;
END $$;
SET ROLE cs_persona_reader;
SELECT * FROM experience.current_chat_history;
SELECT * FROM miniapp_analytics.base_chat_bj;
RESET ROLE;
SQL
# Strip all inherited env: this process cannot see Railway keys, .env files, or remote DB URIs.
env -i PATH="$PATH" DYLD_LIBRARY_PATH="${OPENROUTER_TEST_LIBPQ_DIR:-/opt/homebrew/lib/postgresql@17}" \
 PGRST_DB_URI="postgresql://postgres@127.0.0.1:$task_pg_port/postgres" PGRST_DB_SCHEMAS=experience \
 PGRST_DB_ANON_ROLE=service_role PGRST_SERVER_HOST=127.0.0.1 PGRST_SERVER_PORT="$task_rest_port" \
 "$task_rest_bin" >"$task_dir/postgrest.log" 2>&1 &
task_rest_pid=$!
for task_attempt in {1..50}; do
 if curl -fsS "http://127.0.0.1:$task_rest_port/" >/dev/null 2>&1; then break; fi
 sleep 0.1
done
cd "$task_root"
env -i PATH="$PATH" HOME="$HOME" NODE_ENV=test DATABASE_ENV=test DOTENV_CONFIG_PATH=/dev/null \
 OPENROUTER_RETIREMENT_LOCAL_URL="http://127.0.0.1:$task_rest_port" \
 pnpm --filter @miniapp/backend exec tsx ../../scripts/openrouter-retirement-local.mts
# Replacing views also supports the TEST shape without the production-only role/view.
"${task_psql[@]}" -c 'DROP VIEW miniapp_analytics.base_chat_bj; DROP OWNED BY cs_persona_reader; DROP ROLE cs_persona_reader;' >/dev/null
"${task_psql[@]}" -f "$task_sql/20261016_chat_history_provider_metadata_views.sql" >/dev/null
expect_reject 'Expected exactly 12 legacy columns'
# A contracted target may skip only when the exact reviewed DROP is recorded.
expect_catchup_reject 'Contracted history requires matching reviewed DROP ledger'
"${task_psql[@]}" -c "INSERT INTO supabase_migrations.repo_migrations(filename,checksum) VALUES('20261016_chat_history_drop_provider_metadata.sql','d1b410064f06b63a40a9c15a9b8148e3e43cf3cfdbadaba198b60fcbd7766852');" >/dev/null
"${task_psql[@]}" -f "$task_sql/20261020_openrouter_retirement_catchup_recovery.sql" >/dev/null
"${task_psql[@]}" -f "$task_sql/$task_history_file" >/dev/null
"${task_psql[@]}" -c 'ALTER TABLE experience.chat_history ADD COLUMN llm_generation_id text;' >/dev/null
expect_catchup_reject 'Catch-up recovery requires exactly 12 legacy columns'
"${task_psql[@]}" -c 'ALTER TABLE experience.chat_history DROP COLUMN llm_generation_id;' >/dev/null

# Grafana queries and scheduled refresh names must still work after both real DROP operations.
"${task_psql[@]}" -f "$task_sql/20261020_grafana_provider_metadata_dependencies.sql" >/dev/null
"${task_psql[@]}" >/dev/null <<'SQL'
REFRESH MATERIALIZED VIEW CONCURRENTLY analytics_grafana.mv_free_quota_daily;
REFRESH MATERIALIZED VIEW CONCURRENTLY analytics_grafana.mv_card_unit_economics_30d;
REFRESH MATERIALIZED VIEW CONCURRENTLY analytics_grafana.mv_strategy_downstream_fixture;
SET ROLE grafana_reader;
SELECT * FROM analytics_grafana.v_llm_calls;
SELECT * FROM analytics_grafana.v_card_downstream_fixture;
SELECT * FROM analytics_grafana.v_free_quota_daily;
RESET ROLE;
SQL
printf 'Retirement passed: real parent/alias DROP, catch-up/conflict/budget/dependency guards, provider views/ACL and real PostgREST repositories.\n'
