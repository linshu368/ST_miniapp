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
for task_n in {1..40}; do
  if docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
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
# Execute the exported dashboard queries after replacing Grafana macros with fixed local fixtures.
python3 - "$task_root/docs/grafana/chat-first-token.json" <<'PYSQL' | "${task_psql[@]}" >/dev/null
import json,sys
dashboard=json.load(open(sys.argv[1]))
def resolved(sql,selection):
 sql=sql.replace("$__timeGroupAlias(request_received_at,'5m')", "date_trunc('hour',request_received_at) AS time")
 sql=sql.replace('$__timeFilter(request_received_at)', "request_received_at >= '2026-10-22 00:00:00+08' AND request_received_at < '2026-10-23 00:00:00+08'")
 sql=sql.replace('$__timeFrom()', "'2026-10-22 00:00:00+08'::timestamptz").replace('$__timeTo()', "'2026-10-23 00:00:00+08'::timestamptz")
 return sql.replace('${model:sqlstring}',selection)
print('SET ROLE grafana_cloud;')
for variable in dashboard['templating']['list']:
 print(resolved(variable['query'],"'selected'")+';')
for panel in dashboard['panels']:
 for target in panel.get('targets',[]):
  for selection in ["'selected'","'selected','preparation-fail'","'__all__'"]:
   print(resolved(target['rawSql'],selection)+';')
summary=next(p for p in dashboard['panels'] if p['id']==2)['targets'][0]['rawSql']
cohorts=next(p for p in dashboard['panels'] if p['id']==7)['targets'][0]['rawSql']
print('DO $$ DECLARE r jsonb; BEGIN')
print('SELECT to_jsonb(q) INTO r FROM ('+resolved(summary,"'selected'")+') q;')
print('''IF (r->>'请求量')::int<>150 OR (r->>'前台已看到样本')::int<>149
 OR (r->>'用户总首 token P90')::numeric IS DISTINCT FROM 5.2
 OR (r->>'兜底触发率')::numeric IS DISTINCT FROM 100
 OR abs((r->>'前台已知结果超时率')::numeric - 100.0/150)>0.00001
 OR (r->>'回报覆盖率')::numeric IS DISTINCT FROM 100
 THEN RAISE EXCEPTION 'Dashboard business metrics or seconds conversion changed'; END IF;''')
print('IF NOT COALESCE((SELECT bool_and("总等待上限"=6) FROM ('+resolved(cohorts,"'selected'")+') q),false) THEN RAISE EXCEPTION \'Dashboard loses frozen global limit\'; END IF;')
print('END $$;')
print('RESET ROLE;')
PYSQL
echo 'PASS: first-token SQL identity, delivery CAS, frozen quote, reporting ACL, and 149/150 windows'

# Supabase repositories through real PostgREST; only the API port is mapped to loopback.
docker run --rm -d --network "$task_network" --name "$task_rest_container" \
  -e PGRST_DB_URI="postgres://postgres@$task_container:5432/postgres" \
  -e GHCRTS="-N1" -e PGRST_DB_SCHEMAS="experience,miniapp_analytics" -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="first-token-local-fixture-only-jwt-secret-at-least-32-characters" \
  -p 127.0.0.1::3000 postgrest/postgrest:v12.2.12 >/dev/null
task_rest_port="$(docker port "$task_rest_container" 3000/tcp)"
task_rest_port="${task_rest_port##*:}"
for task_n in {1..40}; do
  if curl --silent --fail "http://127.0.0.1:$task_rest_port/" >/dev/null; then break; fi
  sleep 0.25
done
FIRST_TOKEN_TEST_REST_URL="http://127.0.0.1:$task_rest_port" DOTENV_CONFIG_PATH=/dev/null \
  pnpm --dir "$task_root" --filter @miniapp/backend exec vitest run src/infrastructure/repositories/GenerationObservationRepository.integration.test.ts

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
