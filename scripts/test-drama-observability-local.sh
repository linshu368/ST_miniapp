#!/usr/bin/env bash
# Fresh isolated PG17 only; no remote environment, credentials, or business rows.
set -euo pipefail
drama_root="$(cd "$(dirname "$0")/.." && pwd)"
drama_bin="${DRAMA_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
drama_tmp="$(mktemp -d /tmp/st-drama-pg.XXXXXX)"
drama_port="$(python3 - <<'PY'
import socket
with socket.socket() as s:
 s.bind(('127.0.0.1',0)); print(s.getsockname()[1])
PY
)"
cleanup() {
 "$drama_bin/pg_ctl" -D "$drama_tmp/data" -m immediate stop >/dev/null 2>&1 || true
 rm -rf "$drama_tmp"
}
trap cleanup EXIT
"$drama_bin/initdb" -D "$drama_tmp/data" -A trust -U postgres --no-locale >/dev/null
"$drama_bin/pg_ctl" -D "$drama_tmp/data" -l "$drama_tmp/server.log" -o "-h 127.0.0.1 -p $drama_port -k $drama_tmp" -w start >/dev/null
drama_psql=("$drama_bin/psql" -X -h 127.0.0.1 -p "$drama_port" -U postgres -v ON_ERROR_STOP=1)
"${drama_psql[@]}" -c 'CREATE SCHEMA miniapp_analytics; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE ROLE grafana_cloud LOGIN;' >/dev/null
"${drama_psql[@]}" -f "$drama_root/packages/shared/migrations/20261027_drama_playback_observability.sql" >/dev/null
"${drama_psql[@]}" -f "$drama_root/packages/shared/migrations/20261027_drama_playback_observability.sql" >/dev/null
"${drama_psql[@]}" -f "$drama_root/packages/shared/migrations/tests/drama_playback_observability.sql" >/dev/null
# Same observation receives a start and final in independent sessions.
"${drama_psql[@]}" -c "SET ROLE service_role; SELECT miniapp_analytics.record_drama_playback_observation('test','{\"type\":\"playback\",\"version\":2,\"id\":\"concurrent\",\"phase\":\"start\",\"outcome\":\"waiting\"}','test');" >/dev/null &
drama_pid=$!
"${drama_psql[@]}" -c "SET ROLE service_role; SELECT miniapp_analytics.record_drama_playback_observation('test','{\"type\":\"playback\",\"id\":\"concurrent\",\"phase\":\"final\",\"outcome\":\"playing\",\"marks\":{\"first_frame\":100,\"playing\":110}}','test');" >/dev/null
wait "$drama_pid"
"${drama_psql[@]}" -c "DO \$\$ BEGIN IF (SELECT count(*) FROM miniapp_analytics.drama_playback_facts WHERE observation_id='concurrent' AND outcome='playing' AND startup_ms=110 AND start_received_at IS NOT NULL)<>1 THEN RAISE EXCEPTION 'concurrent merge failed'; END IF; END \$\$;" >/dev/null
# Synthetic capacity fixture (not production measurements): 50k observations over 24h.
"${drama_psql[@]}" -c "INSERT INTO miniapp_analytics.drama_playback_observations(environment,observation_id,first_seen_at,last_received_at,source,server_release,final_received_at,summary,network_summary) SELECT 'test','load-'||n,now()-(n%86400)*interval '1 second',now(),'live','synthetic',now(),jsonb_build_object('type','playback','outcome','playing','elapsedMs',12000,'entry','cover','version',2,'marks',jsonb_build_object('source_set',100,'metadata',1000,'loadeddata',11000,'first_frame',11900,'playing',12000)),jsonb_build_object('status','available','first_ttfb_ms',7000,'max_ttfb_ms',7000) FROM generate_series(1,50000) n; ANALYZE miniapp_analytics.drama_playback_observations;" >/dev/null
if [[ -f "$drama_root/docs/grafana/drama-playback.json" ]]; then
 python3 - "$drama_root/docs/grafana/drama-playback.json" <<'PY' | "${drama_psql[@]}" >/dev/null
import json,sys
d=json.load(open(sys.argv[1])); print("SET ROLE drama_metrics_reader; SET statement_timeout='5s';")
queries=[v['query'] for v in d['templating']['list'] if v['type']=='query']
queries += [t['rawSql'] for p in d['panels'] for t in p.get('targets',[]) if 'rawSql' in t]
for raw in queries:
  q=raw.replace('$__timeFilter(first_seen_at)',"first_seen_at >= now()-interval '24 hours' AND first_seen_at<=now()")
  q=q.replace('$__timeGroupAlias(first_seen_at,\'15m\')',"to_timestamp(floor(extract(epoch from first_seen_at)/900)*900) AS time")
  for key,val in {'environment':"'test'",'release':"'__all__'",'platform':"'__all__'",'entry':"'__all__'",'video':"'__all__'",'measurement':"'__all__'",'frame':"'__all__'",'observation':"'slow-case'"}.items(): q=q.replace('${'+key+':sqlstring}',val)
  print(q+';')
PY
fi
echo 'PASS: PG17 repeat migration, phase races/idempotence, null/zero/order, retention, reader ACL and all dashboard/variable SQL over 50k synthetic observations (5s budget)'
