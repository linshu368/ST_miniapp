#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports, user data, model or billing calls.
# Verifies 20261113_growth_prompt_states.sql: idempotent re-run, show cap and interval,
# concurrent shows never exceed the cap, actions, ACL and user cascade.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="st-growth-prompts-${RANDOM}-$$"
cleanup() { docker rm -f "$task_container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 30); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
task_psql=(docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1)

"${task_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA app_core;
CREATE SCHEMA miniapp_features;
GRANT USAGE ON SCHEMA miniapp_features TO service_role;
CREATE TABLE app_core.users(id uuid PRIMARY KEY);
SQL

migration="$task_root/packages/shared/migrations/20261113_growth_prompt_states.sql"
"${task_psql[@]}" >/dev/null < "$migration"
# Re-running must be a no-op rather than an error.
"${task_psql[@]}" >/dev/null < "$migration"

"${task_psql[@]}" <<'SQL'
\set QUIET on
INSERT INTO app_core.users VALUES ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002');
SET ROLE service_role;
DO $t$
DECLARE r jsonb; u uuid := '00000000-0000-4000-8000-000000000001';
BEGIN
  -- Action before any show records nothing.
  r := miniapp_features.record_growth_prompt_event(u, 'vip', 'dismissed', 3, 259200);
  IF (r->>'recorded')::boolean THEN RAISE EXCEPTION 'action without row recorded: %', r; END IF;
  -- First show succeeds, an immediate second is blocked by the interval.
  r := miniapp_features.record_growth_prompt_event(u, 'vip', 'shown', 3, 259200);
  IF NOT (r->>'recorded')::boolean OR (r->>'shown_count')::int <> 1 THEN RAISE EXCEPTION 'first show: %', r; END IF;
  r := miniapp_features.record_growth_prompt_event(u, 'vip', 'shown', 3, 259200);
  IF (r->>'recorded')::boolean OR (r->>'shown_count')::int <> 1 THEN RAISE EXCEPTION 'interval not enforced: %', r; END IF;
  -- Zero interval: the cap still stops at 3.
  r := miniapp_features.record_growth_prompt_event(u, 'vip', 'shown', 3, 0);
  r := miniapp_features.record_growth_prompt_event(u, 'vip', 'shown', 3, 0);
  r := miniapp_features.record_growth_prompt_event(u, 'vip', 'shown', 3, 0);
  IF (r->>'recorded')::boolean OR (r->>'shown_count')::int <> 3 THEN RAISE EXCEPTION 'cap not enforced: %', r; END IF;
  -- A paid user's lower cap (1) applies to an existing count too.
  r := miniapp_features.record_growth_prompt_event(u, 'community', 'shown', 1, 0);
  r := miniapp_features.record_growth_prompt_event(u, 'community', 'shown', 1, 0);
  IF (r->>'recorded')::boolean THEN RAISE EXCEPTION 'cap 1 not enforced: %', r; END IF;
  r := miniapp_features.record_growth_prompt_event(u, 'community', 'accepted', 2, 86400);
  IF NOT (r->>'recorded')::boolean THEN RAISE EXCEPTION 'action not recorded: %', r; END IF;
  IF (SELECT last_action FROM miniapp_features.growth_prompt_states WHERE user_id = u AND prompt = 'community') <> 'accepted' THEN
    RAISE EXCEPTION 'last_action not stored';
  END IF;
  BEGIN
    r := miniapp_features.record_growth_prompt_event(u, 'other', 'shown', 3, 0);
    RAISE EXCEPTION 'invalid prompt accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'invalid growth prompt event' THEN RAISE; END IF;
  END;
END $t$;
-- Direct writes are not allowed for service_role; only the function writes.
DO $acl$
BEGIN
  BEGIN
    INSERT INTO miniapp_features.growth_prompt_states(user_id, prompt) VALUES ('00000000-0000-4000-8000-000000000002', 'vip');
    RAISE EXCEPTION 'service_role direct insert allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $acl$;
RESET ROLE;
SET ROLE anon;
DO $anon$
BEGIN
  BEGIN
    PERFORM miniapp_features.record_growth_prompt_event('00000000-0000-4000-8000-000000000002', 'vip', 'shown', 3, 0);
    RAISE EXCEPTION 'anon execute allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $anon$;
RESET ROLE;
DELETE FROM app_core.users WHERE id = '00000000-0000-4000-8000-000000000001';
DO $cascade$
BEGIN
  IF EXISTS (SELECT 1 FROM miniapp_features.growth_prompt_states) THEN RAISE EXCEPTION 'user cascade failed'; END IF;
END $cascade$;
SQL

# Concurrency: 8 parallel first shows for one user must record exactly one.
"${task_psql[@]}" -c "INSERT INTO app_core.users VALUES ('00000000-0000-4000-8000-000000000003')" >/dev/null
for _ in $(seq 1 8); do
  docker exec "$task_container" psql -X -q -U postgres -tA -c \
    "SET ROLE service_role; SELECT miniapp_features.record_growth_prompt_event('00000000-0000-4000-8000-000000000003','vip','shown',3,259200)->>'recorded'" &
done | sort | uniq -c
wait
count="$(docker exec "$task_container" psql -X -q -U postgres -tA -c \
  "SELECT shown_count FROM miniapp_features.growth_prompt_states WHERE user_id='00000000-0000-4000-8000-000000000003' AND prompt='vip'")"
if [[ "$count" != "1" ]]; then echo "concurrent shows recorded $count" >&2; exit 1; fi
echo "growth prompt states migration: OK"
