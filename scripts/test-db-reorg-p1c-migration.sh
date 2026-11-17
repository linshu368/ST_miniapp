#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261117_db_reorg_cs_grants.sql: idempotent re-run; CS roles lose direct reads on business
# tables but keep cs_feed / miniapp_analytics; FK-checked writes into cs.* still work; the legacy role is
# dropped; an environment without the CS roles is skipped safely.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261117_db_reorg_cs_grants.sql"

run_case() {
  local with_roles="$1"
  local task_container="st-db-reorg-p1c-${RANDOM}-$$"
  docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
  # shellcheck disable=SC2064
  trap "docker rm -f $task_container >/dev/null 2>&1 || true" RETURN
  for _ in $(seq 1 30); do
    if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
      docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
    sleep 1
  done
  local task_psql=(docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1)

  "${task_psql[@]}" >/dev/null <<'SQL'
CREATE SCHEMA app_core; CREATE SCHEMA billing; CREATE SCHEMA experience; CREATE SCHEMA miniapp_features;
CREATE SCHEMA miniapp_traffic; CREATE SCHEMA miniapp_analytics; CREATE SCHEMA cs_feed; CREATE SCHEMA cs;
CREATE TABLE app_core.users(id uuid PRIMARY KEY, tg_id text);
CREATE TABLE billing.user_wallets(user_id uuid PRIMARY KEY);
CREATE TABLE experience.chat_sessions(id uuid PRIMARY KEY);
CREATE TABLE miniapp_features.daily_checkins(id uuid PRIMARY KEY);
CREATE TABLE miniapp_traffic.botlinks(id bigint PRIMARY KEY);
CREATE VIEW miniapp_analytics.v_users AS SELECT id FROM app_core.users;
CREATE VIEW cs_feed.user_identities WITH (security_barrier = true) AS SELECT id AS user_id, tg_id FROM app_core.users;
CREATE TABLE cs.conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES app_core.users(id));
INSERT INTO app_core.users VALUES ('00000000-0000-4000-8000-000000000001', '1');
SQL
  if [[ "$with_roles" == yes ]]; then
    "${task_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE cs_runtime_v1 NOLOGIN; CREATE ROLE cs_persona_reader NOLOGIN; CREATE ROLE cs_outreach_reader_v1 NOLOGIN;
-- Mirrors ST_cs_platform migrations 009 / 016 plus 20261117_db_reorg_ops_cs_feed.sql.
GRANT USAGE ON SCHEMA cs, app_core, billing, experience, cs_feed TO cs_runtime_v1;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA cs TO cs_runtime_v1;
GRANT SELECT ON app_core.users, billing.user_wallets, experience.chat_sessions, cs_feed.user_identities TO cs_runtime_v1;
GRANT USAGE ON SCHEMA app_core, billing, experience, miniapp_features, miniapp_traffic, miniapp_analytics, cs_feed TO cs_persona_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA app_core, billing, experience, miniapp_features, miniapp_traffic, miniapp_analytics, cs_feed TO cs_persona_reader;
GRANT USAGE ON SCHEMA app_core, billing, experience, miniapp_features, miniapp_traffic, miniapp_analytics TO cs_outreach_reader_v1;
GRANT SELECT ON ALL TABLES IN SCHEMA app_core, billing, experience, miniapp_features, miniapp_traffic, miniapp_analytics TO cs_outreach_reader_v1;
GRANT CONNECT ON DATABASE postgres TO cs_outreach_reader_v1;
SQL
  fi

  "${task_psql[@]}" >/dev/null < "$migration"
  # Re-running must be a no-op rather than an error.
  "${task_psql[@]}" >/dev/null < "$migration"

  if [[ "$with_roles" != yes ]]; then
    echo "case with_roles=no OK"
    return
  fi

  "${task_psql[@]}" <<'SQL'
\set QUIET on
DO $chk$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cs_outreach_reader_v1') THEN RAISE EXCEPTION 'legacy role survived'; END IF;
  IF has_table_privilege('cs_runtime_v1', 'app_core.users', 'SELECT')
     OR has_schema_privilege('cs_runtime_v1', 'billing', 'USAGE')
     OR has_table_privilege('cs_runtime_v1', 'experience.chat_sessions', 'SELECT') THEN
    RAISE EXCEPTION 'cs_runtime_v1 still reads business tables';
  END IF;
  IF NOT has_table_privilege('cs_runtime_v1', 'cs_feed.user_identities', 'SELECT')
     OR NOT has_table_privilege('cs_runtime_v1', 'cs.conversations', 'INSERT') THEN
    RAISE EXCEPTION 'cs_runtime_v1 lost cs / cs_feed';
  END IF;
  IF has_schema_privilege('cs_persona_reader', 'app_core', 'USAGE')
     OR has_table_privilege('cs_persona_reader', 'miniapp_features.daily_checkins', 'SELECT')
     OR has_table_privilege('cs_persona_reader', 'miniapp_traffic.botlinks', 'SELECT') THEN
    RAISE EXCEPTION 'cs_persona_reader still reads business tables';
  END IF;
  IF NOT has_table_privilege('cs_persona_reader', 'miniapp_analytics.v_users', 'SELECT')
     OR NOT has_table_privilege('cs_persona_reader', 'cs_feed.user_identities', 'SELECT') THEN
    RAISE EXCEPTION 'cs_persona_reader lost cs_feed / miniapp_analytics';
  END IF;
END $chk$;
-- Behaviour as the role: views readable, base table denied, FK-checked write still works.
SET ROLE cs_runtime_v1;
SELECT count(*) FROM cs_feed.user_identities \gset
INSERT INTO cs.conversations(user_id) VALUES ('00000000-0000-4000-8000-000000000001');
DO $deny$
BEGIN
  BEGIN
    PERFORM 1 FROM app_core.users;
    RAISE EXCEPTION 'direct read allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $deny$;
RESET ROLE;
SET ROLE cs_persona_reader;
SELECT count(*) FROM miniapp_analytics.v_users \gset
RESET ROLE;
SQL
  echo "case with_roles=yes OK"
}

run_case yes
run_case no
echo 'OK: 20261117_db_reorg_cs_grants.sql'
