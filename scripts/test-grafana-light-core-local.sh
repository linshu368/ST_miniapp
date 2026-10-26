#!/usr/bin/env bash
# Isolated local PG17 only. Never reads remote env or credentials.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="st-grafana-light-$$"
trap 'docker rm -f "$task_container" >/dev/null 2>&1 || true' EXIT
docker run --rm -d --name "$task_container" -e POSTGRES_HOST_AUTH_METHOD=trust -v "$task_root:$task_root:ro" postgres:17 >/dev/null
for task_n in {1..120}; do
  if docker exec "$task_container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1;then break;fi
  sleep .25
done
task_psql=(docker exec -i "$task_container" psql -X -U postgres -v ON_ERROR_STOP=1)
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/tests/grafana_light_core_bootstrap.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261026_grafana_light_core.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/20261026_grafana_light_core.sql" >/dev/null
"${task_psql[@]}" -f "$task_root/packages/shared/migrations/tests/grafana_light_core.sql" >/dev/null
python3 - "$task_root/docs/grafana/operating-core.json" <<'PY' | "${task_psql[@]}" >/dev/null
import json,sys
d=json.load(open(sys.argv[1]))
print('SET ROLE first_token_metrics_reader;')
for p in d['panels']:
 for t in p.get('targets',[]):
  print(t['rawSql'].replace('$__timeFrom()',"now()-interval '6 days'").replace('$__timeTo()','now()')+';')
print('RESET ROLE;')
PY
echo 'PASS: bounded exact daily cache, model attribution, cost coverage, payment/stars, atomic failure, ACL and cron retirement'
if "${task_psql[@]}" -c "SET statement_timeout='50ms'; SELECT pg_sleep(1)" >/dev/null 2>&1;then
  echo 'FAIL: multi-statement cron timeout is ineffective' >&2;exit 1
fi
echo 'PASS: caller timeout interrupts statements in the same SQL batch'
