#!/usr/bin/env bash
# Opt-in isolated PG17 + real PostgREST; no remote credentials or application env files.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/../.." && pwd)"
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
"${task_psql[@]}" -f "$task_root/scripts/database/openrouter-retirement-bootstrap.sql" >/dev/null
"${task_psql[@]}" -f "$task_sql/20260929_venice_chat_history.sql" >/dev/null
"${task_psql[@]}" -c "INSERT INTO experience.venice_chat_history(chat_history_id,llm_generation_id,llm_latency,llm_usage) VALUES('00000000-0000-0000-0000-000000000002','venice-fixture',7,'0'); GRANT SELECT ON experience.venice_chat_history TO cs_persona_reader;" >/dev/null
for task_file in 20261015_openrouter_chat_history.sql 20261015_openrouter_chat_history_backfill.sql 20261015_openrouter_chat_history_venice_exclusion_backfill.sql 20261016_openrouter_original_metadata_fields.sql; do
 "${task_psql[@]}" -f "$task_sql/$task_file" >/dev/null
done
# A valid missing historical identity, a proven no-ID scalar, and an unknown no-ID scalar.
"${task_psql[@]}" -c "DELETE FROM experience.openrouter_chat_history WHERE chat_history_id='00000000-0000-0000-0000-000000000001'; CREATE TABLE experience.view_shape AS SELECT attname,atttypid,atttypmod,attnum FROM pg_attribute WHERE attrelid='experience.current_chat_history'::regclass AND attnum>0;" >/dev/null
expect_reject() {
 if "${task_psql[@]}" -f "$task_sql/20261016_chat_history_drop_provider_metadata.sql" >"$task_dir/reject.log" 2>&1; then
  echo 'FAIL: premature DROP was accepted' >&2; exit 1
 fi
 rg -q "$1" "$task_dir/reject.log"
}
expect_reject 'Legacy column database dependency remains'
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
 if "${task_psql[@]}" -f "$task_sql/20261016_openrouter_history_disposition.sql" >"$task_dir/history-reject.log" 2>&1; then
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
expect_disposition_reject 'History disposition exceeds reviewed 2000-row budget'
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
"${task_psql[@]}" -f "$task_sql/20261016_openrouter_history_disposition.sql" >/dev/null
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
expect_reject 'Reviewed history disposition must be applied and recorded first'
"${task_psql[@]}" -c "INSERT INTO supabase_migrations.repo_migrations(filename,checksum) VALUES('20261016_openrouter_history_disposition.sql','synthetic-local-ledger');" >/dev/null

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
"${task_psql[@]}" -f "$task_sql/20261016_chat_history_drop_provider_metadata.sql" >/dev/null
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
 pnpm --filter @miniapp/backend exec tsx ../../scripts/database/openrouter-retirement-local.mts
# Replacing views also supports the TEST shape without the production-only role/view.
"${task_psql[@]}" -c 'DROP VIEW miniapp_analytics.base_chat_bj; DROP OWNED BY cs_persona_reader; DROP ROLE cs_persona_reader;' >/dev/null
"${task_psql[@]}" -f "$task_sql/20261016_chat_history_provider_metadata_views.sql" >/dev/null
expect_reject 'Expected exactly 12 legacy columns'
printf 'Retirement passed: real parent/alias DROP, catch-up/conflict/budget/dependency guards, provider views/ACL and real PostgREST repositories.\n'
