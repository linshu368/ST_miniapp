#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261117_db_reorg_ops_cs_feed.sql: idempotent re-run, cs_feed views return exactly what the
# CS repo's current SQL returns (users.ts profileSelect / conversations.ts summarySelect), and CS roles
# can read the views without any grant on the underlying business tables.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="st-db-reorg-p1a-${RANDOM}-$$"
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
CREATE ROLE cs_runtime_v1 NOLOGIN;
CREATE ROLE cs_persona_reader NOLOGIN;
CREATE SCHEMA app_core;
CREATE SCHEMA billing;
CREATE SCHEMA experience;
CREATE TABLE app_core.users(
  id uuid PRIMARY KEY, tg_id text NOT NULL, source_id text, miniapp_entered_at timestamptz,
  total_round bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE app_core.miniapp_user_settings(
  user_id uuid PRIMARY KEY REFERENCES app_core.users(id), display_name text, tg_username text,
  tg_first_name text, total_round bigint NOT NULL DEFAULT 0);
CREATE TABLE billing.user_wallets(
  user_id uuid PRIMARY KEY, main_credits numeric NOT NULL DEFAULT 0, bonus_credits numeric NOT NULL DEFAULT 0,
  total_paid_amount numeric NOT NULL DEFAULT 0, first_paid_at timestamptz, last_paid_at timestamptz);
CREATE TABLE billing.vip_memberships(user_id uuid PRIMARY KEY, valid_until timestamptz NOT NULL);
CREATE TABLE billing.payment_orders(id text PRIMARY KEY, user_id uuid NOT NULL, status text NOT NULL, paid_at timestamptz);
CREATE TABLE experience.chat_sessions(
  id uuid PRIMARY KEY, user_id uuid NOT NULL, last_message_at timestamptz, deleted_at timestamptz);
ALTER TABLE app_core.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.user_wallets ENABLE ROW LEVEL SECURITY;

-- u1: full profile; u2: settings with empty names, no wallet, wallet-less paid orders;
-- u3: no settings row, only deleted sessions, pending order; u4: nothing but the user row.
INSERT INTO app_core.users VALUES
  ('00000000-0000-4000-8000-000000000001','101','src_a','2026-10-01T00:00:00Z',42,'2026-09-30T00:00:00Z'),
  ('00000000-0000-4000-8000-000000000002','102',NULL,NULL,0,'2026-10-02T00:00:00Z'),
  ('00000000-0000-4000-8000-000000000003','103','src_b',NULL,7,'2026-10-03T00:00:00Z'),
  ('00000000-0000-4000-8000-000000000004','104',NULL,NULL,0,'2026-10-04T00:00:00Z');
INSERT INTO app_core.miniapp_user_settings VALUES
  ('00000000-0000-4000-8000-000000000001','Alice','alice_tg','A',40),
  ('00000000-0000-4000-8000-000000000002','','','Bob',5);
INSERT INTO billing.user_wallets VALUES
  ('00000000-0000-4000-8000-000000000001',120.5,30.25,99.9,'2026-10-05T00:00:00Z','2026-11-01T00:00:00Z');
INSERT INTO billing.vip_memberships VALUES ('00000000-0000-4000-8000-000000000001','2026-12-01T00:00:00Z');
INSERT INTO billing.payment_orders VALUES
  ('o1','00000000-0000-4000-8000-000000000001','completed','2026-10-05T00:00:00Z'),
  ('o2','00000000-0000-4000-8000-000000000001','completed','2026-11-01T00:00:00Z'),
  ('o3','00000000-0000-4000-8000-000000000002','completed','2026-10-20T00:00:00Z'),
  ('o4','00000000-0000-4000-8000-000000000002','expired',NULL),
  ('o5','00000000-0000-4000-8000-000000000003','pending',NULL);
INSERT INTO experience.chat_sessions VALUES
  ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','2026-11-10T00:00:00Z',NULL),
  ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','2026-11-15T00:00:00Z',NULL),
  ('10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001',NULL,NULL),
  ('10000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','2026-11-16T00:00:00Z','2026-11-16T01:00:00Z');
SQL

migration="$task_root/packages/shared/migrations/20261117_db_reorg_ops_cs_feed.sql"
"${task_psql[@]}" >/dev/null < "$migration"
# Re-running must be a no-op rather than an error.
"${task_psql[@]}" >/dev/null < "$migration"

"${task_psql[@]}" <<'SQL'
\set QUIET on
-- The CS repo's current profile SQL, verbatim except for the trailing WHERE.
CREATE TEMP VIEW cs_original_profile AS
SELECT u.id AS user_id, u.tg_id,
       COALESCE(NULLIF(s.display_name, ''), NULLIF(s.tg_username, ''), NULLIF(s.tg_first_name, '')) AS display_name,
       NULLIF(s.tg_username, '') AS username,
       u.source_id,
       COALESCE(u.miniapp_entered_at, u.created_at) AS registered_at,
       v.valid_until AS vip_valid_until,
       COALESCE(w.total_paid_amount, 0)::numeric(12, 2)::text AS total_paid_amount,
       COALESCE(p.paid_count, 0)::int AS paid_count,
       COALESCE(w.first_paid_at, p.first_paid_at) AS first_paid_at,
       COALESCE(w.last_paid_at, p.last_paid_at) AS last_paid_at,
       (COALESCE(w.main_credits, 0) + COALESCE(w.bonus_credits, 0))::numeric(14, 2)::text AS credits_balance,
       COALESCE(u.total_round, s.total_round, 0)::text AS total_rounds,
       cs_last.last_message_at AS last_chat_at
FROM app_core.users u
LEFT JOIN app_core.miniapp_user_settings s ON s.user_id = u.id
LEFT JOIN billing.user_wallets w ON w.user_id = u.id
LEFT JOIN billing.vip_memberships v ON v.user_id = u.id
LEFT JOIN LATERAL (
  SELECT count(*) AS paid_count, min(o.paid_at) AS first_paid_at, max(o.paid_at) AS last_paid_at
  FROM billing.payment_orders o
  WHERE o.user_id = u.id AND o.status = 'completed'
) p ON true
LEFT JOIN LATERAL (
  SELECT cs.last_message_at FROM experience.chat_sessions cs
  WHERE cs.user_id = u.id AND cs.deleted_at IS NULL
  ORDER BY cs.last_message_at DESC NULLS LAST
  LIMIT 1
) cs_last ON true;

CREATE TEMP VIEW feed_profile_as_text AS
SELECT user_id, tg_id, display_name, username, source_id, registered_at, vip_valid_until,
       total_paid_amount::text, paid_count, first_paid_at, last_paid_at, credits_balance::text,
       total_rounds::text, last_chat_at
FROM cs_feed.user_profiles;

DO $cmp$
DECLARE diff int;
BEGIN
  SELECT count(*) INTO diff FROM (
    (SELECT * FROM cs_original_profile EXCEPT ALL SELECT * FROM feed_profile_as_text)
    UNION ALL
    (SELECT * FROM feed_profile_as_text EXCEPT ALL SELECT * FROM cs_original_profile)
  ) d;
  IF diff <> 0 THEN RAISE EXCEPTION 'cs_feed.user_profiles differs from CS profileSelect by % row(s)', diff; END IF;
  IF (SELECT count(*) FROM cs_feed.user_profiles) <> 4 THEN RAISE EXCEPTION 'profile row count'; END IF;

  -- Identity view matches the name expression used by summarySelect / outreach / alerts.
  SELECT count(*) INTO diff FROM (
    (SELECT u.id, u.tg_id,
            COALESCE(NULLIF(s.display_name, ''), NULLIF(s.tg_username, ''), NULLIF(s.tg_first_name, '')),
            NULLIF(s.tg_username, '')
     FROM app_core.users u LEFT JOIN app_core.miniapp_user_settings s ON s.user_id = u.id
     EXCEPT ALL SELECT user_id, tg_id, display_name, username FROM cs_feed.user_identities)
    UNION ALL
    (SELECT user_id, tg_id, display_name, username FROM cs_feed.user_identities
     EXCEPT ALL SELECT u.id, u.tg_id,
            COALESCE(NULLIF(s.display_name, ''), NULLIF(s.tg_username, ''), NULLIF(s.tg_first_name, '')),
            NULLIF(s.tg_username, '')
     FROM app_core.users u LEFT JOIN app_core.miniapp_user_settings s ON s.user_id = u.id)
  ) d;
  IF diff <> 0 THEN RAISE EXCEPTION 'cs_feed.user_identities differs by % row(s)', diff; END IF;

  -- Spot checks on the edge rows.
  IF (SELECT display_name FROM cs_feed.user_identities WHERE tg_id = '102') <> 'Bob' THEN RAISE EXCEPTION 'name fallback'; END IF;
  IF (SELECT paid_count FROM cs_feed.user_profiles WHERE tg_id = '102') <> 1 THEN RAISE EXCEPTION 'paid_count'; END IF;
  IF (SELECT last_chat_at FROM cs_feed.user_profiles WHERE tg_id = '101') <> '2026-11-15T00:00:00Z' THEN RAISE EXCEPTION 'last chat'; END IF;
  IF (SELECT last_chat_at FROM cs_feed.user_profiles WHERE tg_id = '103') IS NOT NULL THEN RAISE EXCEPTION 'deleted session leaked'; END IF;
END $cmp$;

-- CS roles read the views with no grant on any business table.
SET ROLE cs_runtime_v1;
SELECT count(*) FROM cs_feed.user_profiles \gset
SELECT count(*) FROM cs_feed.user_identities \gset
DO $deny$
BEGIN
  BEGIN
    PERFORM 1 FROM app_core.users;
    RAISE EXCEPTION 'cs_runtime_v1 read app_core.users directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $deny$;
RESET ROLE;
SET ROLE cs_persona_reader;
SELECT count(*) FROM cs_feed.user_profiles \gset
RESET ROLE;

-- Nobody but service_role uses ops; PUBLIC has nothing on either schema.
DO $acl$
BEGIN
  IF has_schema_privilege('anon', 'ops', 'USAGE') OR has_schema_privilege('authenticated', 'cs_feed', 'USAGE')
     OR has_schema_privilege('cs_runtime_v1', 'ops', 'USAGE') THEN
    RAISE EXCEPTION 'unexpected schema privilege';
  END IF;
  IF NOT has_schema_privilege('service_role', 'ops', 'USAGE') THEN RAISE EXCEPTION 'service_role lacks ops'; END IF;
  IF has_table_privilege('anon', 'cs_feed.user_profiles', 'SELECT') THEN RAISE EXCEPTION 'anon can read cs_feed'; END IF;
END $acl$;
SQL

echo 'OK: 20261117_db_reorg_ops_cs_feed.sql'
