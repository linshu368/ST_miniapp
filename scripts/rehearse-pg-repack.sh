#!/usr/bin/env bash
# Disposable PG17 rehearsal for 5b step 3 (no remote URI, no real data):
# - builds pg_repack 1.5.2 from the pinned upstream tag commit (the version Supabase ships; PGDG only has 1.5.3) into a
#   local image, applies 20261119_db_reorg_p5b_pg_repack_extension.sql, and mirrors Supabase ownership of schema repack;
# - repacks, as a NON-superuser table owner with the workflow's flags, a TOAST-heavy table whose big column was dropped
#   while another session keeps inserting;
# - asserts: the dropped column's TOAST is reclaimed, original rows are byte-identical, every concurrent insert landed
#   without error, no repack trigger is left behind.
# The built image st-repack-pg17:rehearsal is kept for reruns (docker rmi it when done).
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
c="st-repack-rehearsal-$$"
b="st-repack-build-$$"
trap 'docker rm -f "$c" "$b" >/dev/null 2>&1 || true' EXIT
if ! docker image inspect st-repack-pg17:rehearsal >/dev/null 2>&1; then
docker run --name "$b" --entrypoint bash postgres:17 -c '
set -e
apt-get -o Acquire::http::Timeout=30 -o Acquire::Retries=5 update -qq >/dev/null
apt-get -o Acquire::http::Timeout=30 -o Acquire::Retries=5 install -y -qq --no-install-recommends ca-certificates git build-essential postgresql-server-dev-17 libssl-dev zlib1g-dev liblz4-dev libzstd-dev libreadline-dev libselinux1-dev libkrb5-dev >/dev/null 2>&1
cd /tmp && git clone -q https://github.com/reorg/pg_repack.git && cd pg_repack && git checkout -q 9f36c65bd57ca1b228025687843758556b56df8e
make -s PG_CONFIG=/usr/lib/postgresql/17/bin/pg_config >/dev/null 2>&1
make -s PG_CONFIG=/usr/lib/postgresql/17/bin/pg_config install >/dev/null 2>&1
./bin/pg_repack --version'
docker commit --change 'ENTRYPOINT ["docker-entrypoint.sh"]' --change 'CMD ["postgres"]' "$b" st-repack-pg17:rehearsal >/dev/null
fi
docker run -d --rm --name "$c" -e POSTGRES_HOST_AUTH_METHOD=trust st-repack-pg17:rehearsal >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$c" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$c" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$c" psql -X -q -U postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE owner_role LOGIN NOSUPERUSER;
GRANT CREATE ON DATABASE postgres TO owner_role;
SQL
docker exec -i "$c" psql -X -q -U postgres -v ON_ERROR_STOP=1 <"$task_root/packages/shared/migrations/20261119_db_reorg_p5b_pg_repack_extension.sql"
docker exec -i "$c" psql -X -q -U postgres -v ON_ERROR_STOP=1 <<'SQL'
-- Supabase: postgres creates the extension and owns schema repack; mirror that for the non-superuser owner.
ALTER SCHEMA repack OWNER TO owner_role;
GRANT ALL ON ALL TABLES IN SCHEMA repack TO owner_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA repack TO owner_role;
SQL
docker exec -i "$c" psql -X -q -U owner_role -d postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA experience;
CREATE TABLE experience.chat_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
  assistant_reply text, history jsonb);
CREATE INDEX ON experience.chat_history (created_at);
INSERT INTO experience.chat_history (assistant_reply, history)
SELECT repeat(md5(g::text), 80), (SELECT jsonb_agg(md5((g * 1000 + i)::text) || repeat('x', 300)) FROM generate_series(1, 120) i)
FROM generate_series(1, 6000) g;
ALTER TABLE experience.chat_history DROP COLUMN history;
SQL
before=$(docker exec "$c" psql -X -At -U postgres -c "SELECT pg_total_relation_size('experience.chat_history')")
sum_before=$(docker exec "$c" psql -X -At -U postgres -c "SELECT md5(string_agg(id::text || assistant_reply, ',' ORDER BY id)) FROM experience.chat_history")
# concurrent writer during the repack: 200 inserts, errors counted
docker exec -d "$c" bash -c 'errs=0; for i in $(seq 1 200); do psql -X -q -U owner_role -d postgres -c "INSERT INTO experience.chat_history (assistant_reply) VALUES (repeat(md5(random()::text), 80))" >/dev/null 2>&1 || errs=$((errs+1)); sleep 0.02; done; echo "$errs" > /tmp/writer_done'
docker exec "$c" bash -c 'PGUSER=owner_role PGDATABASE=postgres /tmp/pg_repack/bin/pg_repack -k --no-order --no-kill-backend --wait-timeout=120 --table=experience.chat_history --elevel=INFO 2>&1'
for _ in $(seq 1 120); do docker exec "$c" test -f /tmp/writer_done && break; sleep 1; done
writer_errors=$(docker exec "$c" cat /tmp/writer_done)
after=$(docker exec "$c" psql -X -At -U postgres -c "SELECT pg_total_relation_size('experience.chat_history')")
sum_after=$(docker exec "$c" psql -X -At -U postgres -c "SELECT md5(string_agg(id::text || assistant_reply, ',' ORDER BY id)) FROM experience.chat_history WHERE id IN (SELECT id FROM experience.chat_history ORDER BY created_at LIMIT 6000)")
rows=$(docker exec "$c" psql -X -At -U postgres -c "SELECT count(*) FROM experience.chat_history")
leftover=$(docker exec "$c" psql -X -At -U postgres -c "SELECT count(*) FROM pg_trigger WHERE tgrelid='experience.chat_history'::regclass AND NOT tgisinternal")
echo "size before=$before after=$after rows=$rows writer_errors=$writer_errors leftover_triggers=$leftover"
[[ "$sum_before" == "$sum_after" ]] || { echo 'FAIL: original rows changed'; exit 1; }
[[ "$rows" == 6200 && "$writer_errors" == 0 ]] || { echo 'FAIL: concurrent inserts lost or failed'; exit 1; }
[[ "$leftover" == 0 ]] || { echo 'FAIL: repack trigger left behind'; exit 1; }
(( after * 10 < before )) || { echo 'FAIL: dropped column TOAST not reclaimed'; exit 1; }
echo 'rehearsal passed'
