#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261117_db_reorg_ops_alerts_free_zone_events.sql as a NON-superuser with CREATEROLE (like Supabase's
# postgres): idempotent re-run; rows, identity sequences, FK and RLS move with the tables; the old backend SQL
# (FOR UPDATE, INSERT RETURNING, ON CONFLICT DO NOTHING, UPDATE ... FROM a FOR UPDATE SKIP LOCKED CTE) still works
# through the compatibility views as service_role; the new backend SQL works on ops; the analytics view follows;
# anon/authenticated get nothing; free_zone_events stays append-only for service_role.
# Then 20261117_db_reorg_drop_ops_compat_views.sql: idempotent removal of the three views, ops tables untouched,
# refuses while an old name is still a table.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261117_db_reorg_ops_alerts_free_zone_events.sql"
drop_views="$task_root/packages/shared/migrations/20261117_db_reorg_drop_ops_compat_views.sql"
task_container="st-db-reorg-p2b-${RANDOM}-$$"
trap 'docker rm -f "$task_container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
super_psql=(docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1)
admin_psql=(docker exec -i "$task_container" psql -X -q -U app_admin -d postgres -v ON_ERROR_STOP=1)

"${super_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE BYPASSRLS;
GRANT CREATE, CONNECT ON DATABASE postgres TO app_admin;
SQL

# Fixture: production shapes from 20261010_payment_alerting_foundation.sql and 20261112_free_zone.sql.
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE first_token_metrics_reader NOLOGIN;
GRANT service_role, first_token_metrics_reader, anon TO app_admin;
CREATE SCHEMA app_core; CREATE SCHEMA miniapp_features; CREATE SCHEMA miniapp_analytics; CREATE SCHEMA ops;
GRANT USAGE ON SCHEMA app_core, miniapp_features, miniapp_analytics TO service_role, anon, authenticated;
GRANT USAGE ON SCHEMA ops TO service_role;
GRANT USAGE ON SCHEMA miniapp_analytics TO first_token_metrics_reader;

CREATE TABLE app_core.alert_incidents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-z0-9][a-z0-9:_-]{2,191}$'),
  state text NOT NULL CHECK (state IN ('open', 'recovered')),
  severity text NOT NULL CHECK (severity IN ('P0', 'P1', 'P2')),
  confidence text NOT NULL CHECK (confidence IN ('confirmed', 'suspected', 'unknown')),
  location jsonb NOT NULL CHECK (jsonb_typeof(location) = 'object'),
  title text NOT NULL, summary text NOT NULL, recommended_action text,
  latest_evaluation_id uuid NOT NULL, latest_producer_run_id uuid NOT NULL,
  first_firing_at timestamptz, last_firing_at timestamptz, last_healthy_at timestamptz,
  last_observed_at timestamptz NOT NULL, last_window_ended_at timestamptz NOT NULL,
  metrics jsonb NOT NULL DEFAULT '[]'::jsonb, samples jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_incidents_fingerprint_key UNIQUE (fingerprint)
);
CREATE TABLE app_core.alert_delivery_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id bigint NOT NULL REFERENCES app_core.alert_incidents(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('feishu')),
  notification_key text NOT NULL,
  transition text NOT NULL CHECK (transition IN ('firing', 'escalated', 'recovered')),
  state text NOT NULL CHECK (state IN ('pending', 'sending', 'succeeded', 'failed', 'abandoned')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  attempt_count integer NOT NULL DEFAULT 0, next_attempt_at timestamptz, last_attempt_at timestamptz,
  delivered_at timestamptz, last_error_class text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_delivery_attempts_notification_key_key UNIQUE (notification_key)
);
CREATE TABLE miniapp_features.free_zone_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  candidate_id text NOT NULL, event_type text NOT NULL
    CHECK (event_type IN ('listed', 'provider_switched', 'delisted', 'cooldown_ended')),
  cause text CHECK (cause IN ('official', 'business')), providers text[] NOT NULL DEFAULT '{}',
  reason text, metrics jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_core.alert_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_core.alert_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp_features.free_zone_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_core.alert_incidents, app_core.alert_delivery_attempts, miniapp_features.free_zone_events FROM PUBLIC;
GRANT ALL ON app_core.alert_incidents, app_core.alert_delivery_attempts TO service_role;
GRANT SELECT, INSERT ON miniapp_features.free_zone_events TO service_role;
-- Supabase-like default grants that a careless view would inherit.
GRANT SELECT ON ALL TABLES IN SCHEMA app_core TO anon;
REVOKE SELECT ON app_core.alert_incidents, app_core.alert_delivery_attempts FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA app_core GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA miniapp_features GRANT ALL ON TABLES TO anon, authenticated;

CREATE VIEW miniapp_analytics.free_zone_model_events AS
  SELECT candidate_id, event_type, created_at FROM miniapp_features.free_zone_events;
GRANT SELECT ON miniapp_analytics.free_zone_model_events TO first_token_metrics_reader;

INSERT INTO app_core.alert_incidents (fingerprint, state, severity, confidence, location, title, summary,
  latest_evaluation_id, latest_producer_run_id, last_observed_at, last_window_ended_at)
VALUES ('pay:old-1', 'open', 'P1', 'confirmed', '{}', 't', 's', gen_random_uuid(), gen_random_uuid(), now(), now());
INSERT INTO app_core.alert_delivery_attempts (incident_id, channel, notification_key, transition, state, payload, next_attempt_at)
SELECT id, 'feishu', 'pay:old-1:firing:x', 'firing', 'pending', '{}', now() - interval '1 minute' FROM app_core.alert_incidents;
INSERT INTO miniapp_features.free_zone_events (candidate_id, event_type, cause, reason) VALUES ('free-a', 'listed', 'business', 'seed');
SQL

"${admin_psql[@]}" >/dev/null < "$migration"
"${admin_psql[@]}" >/dev/null < "$migration"

"${admin_psql[@]}" <<'SQL'
\set QUIET on
DO $chk$
BEGIN
  IF (SELECT relkind FROM pg_class WHERE oid = 'ops.alert_incidents'::regclass) <> 'r'
     OR (SELECT relkind FROM pg_class WHERE oid = 'ops.alert_delivery_jobs'::regclass) <> 'r'
     OR (SELECT relkind FROM pg_class WHERE oid = 'ops.free_zone_events'::regclass) <> 'r'
     OR (SELECT relkind FROM pg_class WHERE oid = 'app_core.alert_incidents'::regclass) <> 'v'
     OR (SELECT relkind FROM pg_class WHERE oid = 'app_core.alert_delivery_attempts'::regclass) <> 'v'
     OR (SELECT relkind FROM pg_class WHERE oid = 'miniapp_features.free_zone_events'::regclass) <> 'v' THEN
    RAISE EXCEPTION 'tables not moved or compatibility views missing';
  END IF;
  IF (SELECT count(*) FROM ops.alert_incidents) <> 1 OR (SELECT count(*) FROM ops.alert_delivery_jobs) <> 1
     OR (SELECT count(*) FROM ops.free_zone_events) <> 1 THEN
    RAISE EXCEPTION 'rows did not move';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'ops.alert_delivery_jobs'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ops.alert_delivery_jobs'::regclass
                    AND confrelid = 'ops.alert_incidents'::regclass AND contype = 'f') THEN
    RAISE EXCEPTION 'RLS or FK lost';
  END IF;
  IF position('ops.free_zone_events' IN pg_get_viewdef('miniapp_analytics.free_zone_model_events'::regclass)) = 0 THEN
    RAISE EXCEPTION 'analytics view did not follow';
  END IF;
  IF has_table_privilege('anon', 'app_core.alert_incidents', 'SELECT')
     OR has_table_privilege('authenticated', 'app_core.alert_delivery_attempts', 'SELECT')
     OR has_table_privilege('anon', 'miniapp_features.free_zone_events', 'SELECT')
     OR has_table_privilege('anon', 'ops.alert_incidents', 'SELECT') THEN
    RAISE EXCEPTION 'browser roles can read alerts or events';
  END IF;
END $chk$;

-- Old backend SQL through the compatibility views, as service_role.
SET ROLE service_role;
BEGIN;
SELECT id FROM app_core.alert_incidents WHERE fingerprint = 'pay:new-2' FOR UPDATE;
INSERT INTO app_core.alert_incidents (fingerprint, state, severity, confidence, location, title, summary, recommended_action,
  latest_evaluation_id, latest_producer_run_id, first_firing_at, last_firing_at, last_observed_at, last_window_ended_at, metrics, samples)
VALUES ('pay:new-2', 'open', 'P2', 'suspected', '{}'::jsonb, 't2', 's2', NULL, gen_random_uuid(), gen_random_uuid(),
  now(), now(), now(), now(), '[]'::jsonb, '[]'::jsonb) RETURNING id \gset inc_
INSERT INTO app_core.alert_delivery_attempts (incident_id, channel, notification_key, transition, state, payload, next_attempt_at)
VALUES (:inc_id, 'feishu', 'pay:new-2:firing:y', 'firing', 'pending', '{}'::jsonb, now() - interval '2 minutes')
ON CONFLICT (notification_key) DO NOTHING;
INSERT INTO app_core.alert_delivery_attempts (incident_id, channel, notification_key, transition, state, payload, next_attempt_at)
VALUES (:inc_id, 'feishu', 'pay:new-2:firing:y', 'firing', 'pending', '{}'::jsonb, now())
ON CONFLICT (notification_key) DO NOTHING;
UPDATE app_core.alert_incidents SET state = 'recovered', updated_at = now() WHERE id = :inc_id;
COMMIT;
WITH due AS (
  SELECT id FROM app_core.alert_delivery_attempts
  WHERE (state IN ('pending', 'failed') AND next_attempt_at <= now())
     OR (state = 'sending' AND last_attempt_at < now() - interval '2 minutes')
  ORDER BY next_attempt_at NULLS FIRST, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE app_core.alert_delivery_attempts attempts
SET state = 'sending', attempt_count = attempts.attempt_count + 1, last_attempt_at = now(), updated_at = now()
FROM due WHERE attempts.id = due.id
RETURNING attempts.id, attempts.notification_key \gset claimed_
UPDATE app_core.alert_delivery_attempts SET state = 'succeeded', delivered_at = now(), updated_at = now(), last_error_class = NULL
WHERE id = :claimed_id AND state = 'sending';
INSERT INTO miniapp_features.free_zone_events (candidate_id, event_type, cause, providers, reason, metrics)
VALUES ('free-b', 'delisted', 'official', ARRAY['p1']::text[], 'old backend', '{}'::jsonb);
SELECT count(*) AS n FROM miniapp_features.free_zone_events \gset old_events_

-- New backend SQL directly on ops, same role.
WITH due AS (
  SELECT id FROM ops.alert_delivery_jobs
  WHERE (state IN ('pending', 'failed') AND next_attempt_at <= now())
     OR (state = 'sending' AND last_attempt_at < now() - interval '2 minutes')
  ORDER BY next_attempt_at NULLS FIRST, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE ops.alert_delivery_jobs attempts
SET state = 'sending', attempt_count = attempts.attempt_count + 1, last_attempt_at = now(), updated_at = now()
FROM due WHERE attempts.id = due.id
RETURNING attempts.id \gset claimed2_
INSERT INTO ops.free_zone_events (candidate_id, event_type, cause, providers, reason)
VALUES ('free-c', 'listed', 'business', ARRAY[]::text[], 'new backend');
DO $ro$ BEGIN
  BEGIN UPDATE ops.free_zone_events SET reason = 'x'; RAISE EXCEPTION 'events became mutable';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE miniapp_features.free_zone_events SET reason = 'x'; RAISE EXCEPTION 'events view became mutable';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $ro$;
RESET ROLE;

DO $after$
BEGIN
  IF (SELECT count(*) FROM ops.alert_incidents) <> 2
     OR (SELECT count(*) FROM ops.alert_delivery_jobs) <> 2
     OR (SELECT state FROM ops.alert_incidents WHERE fingerprint = 'pay:new-2') <> 'recovered'
     OR (SELECT count(*) FROM ops.alert_delivery_jobs WHERE state = 'succeeded') <> 1
     OR (SELECT count(*) FROM ops.alert_delivery_jobs WHERE state = 'sending') <> 1 THEN
    RAISE EXCEPTION 'old/new alert SQL did not land in ops: %', (SELECT json_agg(j) FROM ops.alert_delivery_jobs j);
  END IF;
  IF (SELECT max(id) FROM ops.alert_incidents) <> 2 THEN RAISE EXCEPTION 'identity sequence did not continue'; END IF;
  IF (SELECT count(*) FROM ops.free_zone_events) <> 3 THEN RAISE EXCEPTION 'free zone events lost'; END IF;
END $after$;
SET ROLE first_token_metrics_reader;
SELECT count(*) AS n FROM miniapp_analytics.free_zone_model_events \gset fz_
RESET ROLE;
SELECT (:fz_n = 3) AS fz_ok \gset
\if :fz_ok
\else
  \echo 'analytics view does not see the moved events'
  SELECT 1 / 0;
\endif
SQL
echo 'OK: 20261117_db_reorg_ops_alerts_free_zone_events.sql'

"${admin_psql[@]}" >/dev/null < "$drop_views"
"${admin_psql[@]}" >/dev/null < "$drop_views"
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $gone$ BEGIN
  IF to_regclass('app_core.alert_incidents') IS NOT NULL OR to_regclass('app_core.alert_delivery_attempts') IS NOT NULL
     OR to_regclass('miniapp_features.free_zone_events') IS NOT NULL THEN
    RAISE EXCEPTION 'compatibility views survived';
  END IF;
  IF (SELECT count(*) FROM ops.alert_incidents) <> 2 OR (SELECT count(*) FROM ops.alert_delivery_jobs) <> 2
     OR (SELECT count(*) FROM ops.free_zone_events) <> 3 THEN
    RAISE EXCEPTION 'ops tables changed';
  END IF;
END $gone$;
CREATE TABLE app_core.alert_incidents (id int);
SQL
if "${admin_psql[@]}" >/dev/null 2>&1 < "$drop_views"; then
  echo 'drop_ops_compat_views ran while app_core.alert_incidents is a table' >&2
  exit 1
fi
echo 'OK: 20261117_db_reorg_drop_ops_compat_views.sql'
