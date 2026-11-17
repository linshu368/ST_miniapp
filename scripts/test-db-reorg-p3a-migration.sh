#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261117_db_reorg_p3a_user_attributions.sql (+ _contract) as a NON-superuser with CREATEROLE:
# - expand is idempotent; backfill complete; traffic_daily_stats and cs_feed.user_profiles return identical rows;
# - enter_user: new account records source, entry markers fill once, no write when nothing changes;
# - old backend writes on app_core.users and the old increment RPC still land in the new tables;
# - check_invite_chat_rounds_reward and record_app_entry read the new tables;
# - pre-step drops the TEST-only funnel_stats view and refuses while other views still depend on dropped columns;
# - contract refuses while a function reads moved columns; reconciles release-window race leftovers (missing
#   attribution values/rows, rounds written only to users), then drops the moved columns and compat objects, idempotently.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
expand="$task_root/packages/shared/migrations/20261117_db_reorg_p3a_user_attributions.sql"
contract="$task_root/packages/shared/migrations/20261117_db_reorg_p3a_user_attributions_contract.sql"
drop_funnel="$task_root/packages/shared/migrations/20261117_db_reorg_p3a_drop_test_funnel_stats.sql"
task_container="st-db-reorg-p3a-${RANDOM}-$$"
trap 'docker rm -f "$task_container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust -e TZ=Asia/Shanghai postgres:17 >/dev/null
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

"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT service_role TO app_admin;
CREATE SCHEMA app_core; CREATE SCHEMA miniapp_traffic; CREATE SCHEMA experience; CREATE SCHEMA billing;
CREATE SCHEMA cs_feed; CREATE SCHEMA miniapp_analytics; CREATE SCHEMA test_fixture;
GRANT USAGE ON SCHEMA app_core, miniapp_traffic, experience TO service_role;

CREATE TABLE app_core.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tg_id text NOT NULL UNIQUE, source_id text,
  bot_entered_at timestamptz, miniapp_entered_at timestamptz, total_round bigint NOT NULL DEFAULT 0,
  st_initialized_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE app_core.miniapp_user_settings (user_id uuid PRIMARY KEY REFERENCES app_core.users(id) ON DELETE CASCADE,
  tg_username text, tg_first_name text, display_name text, total_round bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE app_core.runtime_config (key text PRIMARY KEY, value jsonb);
CREATE TABLE experience.chat_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE experience.chat_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, last_message_at timestamptz, deleted_at timestamptz);
CREATE TABLE billing.user_wallets (user_id uuid PRIMARY KEY, total_paid_amount numeric, first_paid_at timestamptz,
  last_paid_at timestamptz, main_credits numeric, bonus_credits numeric);
CREATE TABLE billing.vip_memberships (user_id uuid PRIMARY KEY, valid_until timestamptz);
CREATE TABLE billing.payment_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text,
  paid_at timestamptz, amount_cents bigint);
CREATE TABLE miniapp_traffic.botlinks (id bigserial PRIMARY KEY, bot_link text, source_id text, created_at timestamptz DEFAULT now(),
  source_name text, start_time date, end_time date, purchase_amount int, procurement_days int);
CREATE TABLE miniapp_traffic.traffic_clicks (id bigserial PRIMARY KEY, stat_date date NOT NULL DEFAULT CURRENT_DATE,
  source_id text NOT NULL, clicks int NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (stat_date, source_id));
CREATE TABLE miniapp_traffic.app_entry_facts (user_id uuid NOT NULL, surface text NOT NULL, source_key text NOT NULL DEFAULT '',
  launched_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT clock_timestamp(), eligibility text NOT NULL,
  eligibility_basis jsonb NOT NULL, converted_at timestamptz);
CREATE UNIQUE INDEX app_entry_facts_pk ON miniapp_traffic.app_entry_facts (user_id, surface, source_key);
CREATE TABLE miniapp_traffic.invite_relations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), inviter_user_id uuid NOT NULL,
  invitee_user_id uuid NOT NULL, invite_code text NOT NULL, bound_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE miniapp_traffic.invite_reward_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), relation_id uuid NOT NULL,
  inviter_user_id uuid NOT NULL, rule_key text NOT NULL, event_ref text NOT NULL, credits int NOT NULL, granted_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION miniapp_traffic.increment_click(p_source_id text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO miniapp_traffic.traffic_clicks (stat_date, source_id, clicks) VALUES (CURRENT_DATE, p_source_id, 1)
  ON CONFLICT (stat_date, source_id) DO UPDATE SET clicks = miniapp_traffic.traffic_clicks.clicks + 1 $$;
CREATE FUNCTION miniapp_traffic.grant_invite_reward(p_relation uuid, p_rule text, p_ref text)
RETURNS TABLE(status text, credits integer) LANGUAGE sql AS $$
  INSERT INTO miniapp_traffic.invite_reward_logs (relation_id, inviter_user_id, rule_key, event_ref, credits)
  SELECT r.id, r.inviter_user_id, p_rule, p_ref, 100 FROM miniapp_traffic.invite_relations r WHERE r.id = p_relation;
  SELECT 'granted'::text, 100 $$;

-- Views exactly as production defines them (2026-11-17), so the in-migration rewrite meets the real text.
CREATE VIEW cs_feed.user_identities WITH (security_barrier = true) AS
 SELECT u.id AS user_id, u.tg_id,
    COALESCE(NULLIF(s.display_name, ''::text), NULLIF(s.tg_username, ''::text), NULLIF(s.tg_first_name, ''::text)) AS display_name,
    NULLIF(s.tg_username, ''::text) AS username
   FROM (app_core.users u LEFT JOIN app_core.miniapp_user_settings s ON ((s.user_id = u.id)));
CREATE VIEW cs_feed.user_profiles WITH (security_barrier = true) AS
 SELECT i.user_id, i.tg_id, i.display_name, i.username, u.source_id,
    COALESCE(u.miniapp_entered_at, u.created_at) AS registered_at, v.valid_until AS vip_valid_until,
    (COALESCE(w.total_paid_amount, (0)::numeric))::numeric(12,2) AS total_paid_amount,
    (COALESCE(p.paid_count, (0)::bigint))::integer AS paid_count,
    COALESCE(w.first_paid_at, p.first_paid_at) AS first_paid_at, COALESCE(w.last_paid_at, p.last_paid_at) AS last_paid_at,
    ((COALESCE(w.main_credits, (0)::numeric) + COALESCE(w.bonus_credits, (0)::numeric)))::numeric(14,2) AS credits_balance,
    COALESCE(u.total_round, s.total_round, (0)::bigint) AS total_rounds, cs_last.last_message_at AS last_chat_at
   FROM ((((((cs_feed.user_identities i
     JOIN app_core.users u ON ((u.id = i.user_id)))
     LEFT JOIN app_core.miniapp_user_settings s ON ((s.user_id = i.user_id)))
     LEFT JOIN billing.user_wallets w ON ((w.user_id = i.user_id)))
     LEFT JOIN billing.vip_memberships v ON ((v.user_id = i.user_id)))
     LEFT JOIN LATERAL ( SELECT count(*) AS paid_count, min(o.paid_at) AS first_paid_at, max(o.paid_at) AS last_paid_at
           FROM billing.payment_orders o WHERE ((o.user_id = i.user_id) AND (o.status = 'completed'::text))) p ON (true))
     LEFT JOIN LATERAL ( SELECT cs.last_message_at FROM experience.chat_sessions cs
          WHERE ((cs.user_id = i.user_id) AND (cs.deleted_at IS NULL)) ORDER BY cs.last_message_at DESC NULLS LAST LIMIT 1) cs_last ON (true));
CREATE VIEW miniapp_traffic.traffic_daily_stats AS
 WITH source_aggregates AS (
         SELECT b_1.source_id,
            ( SELECT count(DISTINCT u_1.id) AS count FROM app_core.users u_1
                  WHERE ((u_1.source_id = b_1.source_id) AND (u_1.total_round >= 4) AND ((COALESCE(u_1.miniapp_entered_at, u_1.created_at))::date >= b_1.start_time) AND ((COALESCE(u_1.miniapp_entered_at, u_1.created_at))::date <= b_1.end_time))) AS total_activated_users,
            ( SELECT COALESCE(((sum(p.amount_cents))::numeric / 100.0), (0)::numeric) AS "coalesce" FROM billing.payment_orders p
                  WHERE ((p.status = 'completed'::text) AND (p.user_id IN ( SELECT u_1.id FROM app_core.users u_1
                          WHERE ((u_1.source_id = b_1.source_id) AND (u_1.total_round >= 4) AND ((COALESCE(u_1.miniapp_entered_at, u_1.created_at))::date >= b_1.start_time) AND ((COALESCE(u_1.miniapp_entered_at, u_1.created_at))::date <= b_1.end_time)))))) AS total_ltv_amount,
                CASE WHEN (b_1.end_time < CURRENT_DATE) THEN b_1.end_time ELSE CURRENT_DATE END AS weekly_ref_date_calc,
            GREATEST(0, ((LEAST(CURRENT_DATE, b_1.end_time) - b_1.start_time) + 1)) AS elapsed_days
           FROM miniapp_traffic.botlinks b_1
        ), weekly_agg AS (
         SELECT sa_1.source_id, count(DISTINCT u_1.id) AS weekly_activated_users
           FROM ((source_aggregates sa_1 JOIN miniapp_traffic.botlinks b_1 ON ((b_1.source_id = sa_1.source_id)))
             LEFT JOIN app_core.users u_1 ON (((u_1.source_id = sa_1.source_id) AND (u_1.total_round >= 4) AND ((COALESCE(u_1.miniapp_entered_at, u_1.created_at))::date > (sa_1.weekly_ref_date_calc - '7 days'::interval)) AND ((COALESCE(u_1.miniapp_entered_at, u_1.created_at))::date <= sa_1.weekly_ref_date_calc) AND ((COALESCE(u_1.miniapp_entered_at, u_1.created_at))::date >= b_1.start_time) AND ((COALESCE(u_1.miniapp_entered_at, u_1.created_at))::date <= b_1.end_time))))
          GROUP BY sa_1.source_id
        )
 SELECT c.stat_date, c.source_id, b.source_name, b.start_time, b.end_time, b.purchase_amount, b.procurement_days,
        CASE WHEN (COALESCE(b.procurement_days, 0) > 0) THEN round(((b.purchase_amount)::numeric / (b.procurement_days)::numeric), 2) ELSE NULL::numeric END AS daily_cost,
    c.clicks, COALESCE(u.activated_users, (0)::bigint) AS activated_users,
        CASE WHEN ((COALESCE(u.activated_users, (0)::bigint) > 0) AND (COALESCE(b.procurement_days, 0) > 0)) THEN round((((b.purchase_amount)::numeric / (b.procurement_days)::numeric) / (u.activated_users)::numeric), 2) ELSE NULL::numeric END AS daily_cpa,
        CASE WHEN (COALESCE(c.clicks, 0) > 0) THEN round(((COALESCE(u.activated_users, (0)::bigint))::numeric / (c.clicks)::numeric), 4) ELSE NULL::numeric END AS conversion_rate,
    sa.total_activated_users,
        CASE WHEN ((sa.total_activated_users > 0) AND (COALESCE(b.procurement_days, 0) > 0)) THEN round((LEAST((((b.purchase_amount)::numeric / (b.procurement_days)::numeric) * (sa.elapsed_days)::numeric), (b.purchase_amount)::numeric) / (sa.total_activated_users)::numeric), 2) ELSE NULL::numeric END AS cumulative_cpa,
        CASE WHEN (sa.total_activated_users > 0) THEN round((sa.total_ltv_amount / (sa.total_activated_users)::numeric), 2) ELSE NULL::numeric END AS cumulative_ltv,
    sa.weekly_ref_date_calc AS weekly_ref_date,
        CASE WHEN ((wa.weekly_activated_users > 0) AND (COALESCE(b.procurement_days, 0) > 0)) THEN round(((((b.purchase_amount)::numeric / (b.procurement_days)::numeric) * (LEAST(7, ((sa.weekly_ref_date_calc - b.start_time) + 1)))::numeric) / (wa.weekly_activated_users)::numeric), 2) ELSE NULL::numeric END AS weekly_cpa
   FROM ((((miniapp_traffic.traffic_clicks c
     JOIN miniapp_traffic.botlinks b ON (((b.source_id = c.source_id) AND (c.stat_date >= b.start_time) AND (c.stat_date <= b.end_time))))
     LEFT JOIN LATERAL ( SELECT count(DISTINCT u_1.id) AS activated_users FROM app_core.users u_1
          WHERE ((u_1.source_id = c.source_id) AND ((COALESCE(u_1.miniapp_entered_at, u_1.created_at))::date = c.stat_date) AND (u_1.total_round >= 4))) u ON (true))
     LEFT JOIN source_aggregates sa ON ((sa.source_id = c.source_id)))
     LEFT JOIN weekly_agg wa ON ((wa.source_id = c.source_id)));
CREATE VIEW miniapp_analytics.base_users_bj AS SELECT id, miniapp_entered_at FROM app_core.users;
CREATE VIEW miniapp_analytics.v_daily_funnel AS SELECT count(*) AS n FROM miniapp_analytics.base_users_bj;
CREATE VIEW miniapp_analytics.v_user_ecosystem_daily AS SELECT count(*) AS n FROM miniapp_analytics.base_users_bj;
CREATE VIEW miniapp_analytics.base_cohort_members AS SELECT id FROM app_core.users;
CREATE VIEW miniapp_analytics.v_miniapp_cohort_ltv AS SELECT count(*) AS n FROM miniapp_analytics.base_cohort_members;
CREATE VIEW miniapp_analytics.v_miniapp_cohort_retention AS SELECT count(*) AS n FROM miniapp_analytics.base_cohort_members;
CREATE VIEW miniapp_analytics.base_first_session AS SELECT 1 AS n;
CREATE VIEW miniapp_analytics.base_chat_bj AS SELECT 1 AS n;

-- Seed: 60 users across two channels, rounds 0..9, entry dates spread over the campaign window.
INSERT INTO miniapp_traffic.botlinks (source_id, source_name, start_time, end_time, purchase_amount, procurement_days)
VALUES ('chan_a', 'A', CURRENT_DATE - 20, CURRENT_DATE + 5, 3000, 30), ('chan_b', 'B', CURRENT_DATE - 10, CURRENT_DATE - 2, 900, 9);
INSERT INTO app_core.users (tg_id, source_id, bot_entered_at, miniapp_entered_at, total_round, st_initialized_at, created_at)
SELECT (1000 + g)::text, CASE g % 3 WHEN 0 THEN 'chan_a' WHEN 1 THEN 'chan_b' END,
  CASE WHEN g % 4 = 0 THEN now() - (g || ' days')::interval END,
  CASE WHEN g % 5 <> 0 THEN now() - ((g % 18) || ' days')::interval END, g % 10,
  CASE WHEN g % 7 = 0 THEN now() - interval '90 days' END, now() - ((g % 25) || ' days')::interval
FROM generate_series(1, 60) g;
INSERT INTO app_core.miniapp_user_settings (user_id, tg_username, display_name, total_round)
SELECT id, 'u' || tg_id, NULL, total_round FROM app_core.users WHERE tg_id::int % 2 = 0;
INSERT INTO miniapp_traffic.traffic_clicks (stat_date, source_id, clicks)
SELECT CURRENT_DATE - d, s, 10 + d FROM generate_series(0, 18) d, unnest(ARRAY['chan_a', 'chan_b']) s;
INSERT INTO billing.payment_orders (user_id, status, paid_at, amount_cents)
SELECT id, 'completed', now(), 990 FROM app_core.users WHERE total_round >= 6;
INSERT INTO billing.user_wallets (user_id, total_paid_amount, main_credits, bonus_credits) SELECT id, 9.9, 100, 5 FROM app_core.users WHERE total_round = 9;

CREATE TABLE test_fixture.traffic_before AS SELECT * FROM miniapp_traffic.traffic_daily_stats;
CREATE TABLE test_fixture.profiles_before AS SELECT * FROM cs_feed.user_profiles;
SQL

"${admin_psql[@]}" >/dev/null < "$expand"
"${admin_psql[@]}" >/dev/null < "$expand"

"${admin_psql[@]}" <<'SQL'
\set QUIET on
DO $chk$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM ((SELECT * FROM test_fixture.traffic_before EXCEPT ALL SELECT * FROM miniapp_traffic.traffic_daily_stats)
    UNION ALL (SELECT * FROM miniapp_traffic.traffic_daily_stats EXCEPT ALL SELECT * FROM test_fixture.traffic_before)) x;
  IF n <> 0 OR (SELECT count(*) FROM test_fixture.traffic_before) < 20 THEN RAISE EXCEPTION 'traffic_daily_stats changed: % rows', n; END IF;
  IF (SELECT sum(activated_users) FROM test_fixture.traffic_before) = 0 THEN RAISE EXCEPTION 'traffic fixture too thin'; END IF;
  SELECT count(*) INTO n FROM ((SELECT * FROM test_fixture.profiles_before EXCEPT ALL SELECT * FROM cs_feed.user_profiles)
    UNION ALL (SELECT * FROM cs_feed.user_profiles EXCEPT ALL SELECT * FROM test_fixture.profiles_before)) x;
  IF n <> 0 THEN RAISE EXCEPTION 'cs_feed.user_profiles changed: % rows', n; END IF;
  IF (SELECT count(*) FROM miniapp_traffic.user_attributions) <> 60
     OR (SELECT count(*) FROM experience.user_chat_stats) <> 54
     OR (SELECT count(*) FROM miniapp_traffic.user_attributions WHERE st_initialized_at IS NOT NULL) <> 8 THEN
    RAISE EXCEPTION 'backfill incomplete';
  END IF;
  IF to_regclass('miniapp_analytics.base_users_bj') IS NOT NULL OR to_regclass('miniapp_analytics.v_miniapp_cohort_ltv') IS NOT NULL THEN
    RAISE EXCEPTION 'unused analytics views survived';
  END IF;
END $chk$;

-- New backend: first login with a source, then repeated logins, then a bot start.
CREATE TABLE test_fixture.r (k text PRIMARY KEY, j jsonb);
INSERT INTO test_fixture.r VALUES ('first', miniapp_traffic.enter_user('5001', 'chan_a', 'miniapp'));
INSERT INTO test_fixture.r VALUES ('again', miniapp_traffic.enter_user('5001', NULL, 'miniapp'));
INSERT INTO test_fixture.r VALUES ('plain', miniapp_traffic.enter_user('5002', NULL, NULL));
INSERT INTO test_fixture.r VALUES ('bot', miniapp_traffic.enter_user('5002', 'chan_b', 'bot'));
INSERT INTO test_fixture.r VALUES ('bot2', miniapp_traffic.enter_user('5002', 'chan_a', 'bot'));
DO $enter$
DECLARE
  f jsonb := (SELECT j FROM test_fixture.r WHERE k = 'first'); a jsonb := (SELECT j FROM test_fixture.r WHERE k = 'again');
  p jsonb := (SELECT j FROM test_fixture.r WHERE k = 'plain'); b jsonb := (SELECT j FROM test_fixture.r WHERE k = 'bot');
  b2 jsonb := (SELECT j FROM test_fixture.r WHERE k = 'bot2');
BEGIN
  IF NOT has_function_privilege('service_role', 'miniapp_traffic.enter_user(text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'experience.increment_user_total_round(uuid,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'miniapp_traffic.enter_user(text,text,text)', 'EXECUTE')
     OR has_table_privilege('anon', 'miniapp_traffic.user_attributions', 'SELECT') THEN
    RAISE EXCEPTION 'function/table privileges wrong'; END IF;
  IF f->>'source_id' <> 'chan_a' OR f->>'miniapp_entered_at' IS NULL OR (f->>'total_round')::int <> 0 OR f->>'id' IS NULL THEN
    RAISE EXCEPTION 'first login wrong: %', f; END IF;
  IF a->>'miniapp_entered_at' <> f->>'miniapp_entered_at' OR a->>'id' <> f->>'id' THEN RAISE EXCEPTION 'repeat login changed: %', a; END IF;
  IF p->>'source_id' IS NOT NULL OR p->>'miniapp_entered_at' IS NOT NULL THEN RAISE EXCEPTION 'plain lookup wrote markers: %', p; END IF;
  IF b->>'bot_entered_at' IS NULL OR b->>'source_id' <> 'chan_b' THEN RAISE EXCEPTION 'bot start wrong: %', b; END IF;
  IF b2->>'source_id' <> 'chan_b' OR b2->>'bot_entered_at' <> b->>'bot_entered_at' THEN RAISE EXCEPTION 'second bot start overwrote: %', b2; END IF;
END $enter$;

-- Old backend during the release window.
INSERT INTO app_core.users (tg_id, source_id, miniapp_entered_at) VALUES ('6001', 'chan_b', now());
UPDATE app_core.users SET bot_entered_at = now() WHERE tg_id = '6001';
SELECT 1 FROM app_core.increment_user_total_round((SELECT id FROM app_core.users WHERE tg_id = '1002'), 1) \g /dev/null
SELECT 1 FROM experience.increment_user_total_round((SELECT id FROM app_core.users WHERE tg_id = '5001'), 1) \g /dev/null
DO $old$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM miniapp_traffic.user_attributions a JOIN app_core.users u ON u.id = a.user_id
     WHERE u.tg_id = '6001' AND a.source_id = 'chan_b' AND a.miniapp_entered_at IS NOT NULL AND a.bot_entered_at IS NOT NULL) THEN
    RAISE EXCEPTION 'old backend writes not mirrored'; END IF;
  IF (SELECT s.total_round FROM experience.user_chat_stats s JOIN app_core.users u ON u.id = s.user_id WHERE u.tg_id = '1002') <> 3
     OR (SELECT total_round FROM app_core.users WHERE tg_id = '1002') <> 3
     OR (SELECT s.total_round FROM app_core.miniapp_user_settings s JOIN app_core.users u ON u.id = s.user_id WHERE u.tg_id = '1002') <> 3
     OR experience.user_total_round((SELECT id FROM app_core.users WHERE tg_id = '5001')) <> 1 THEN
    RAISE EXCEPTION 'round increments wrong'; END IF;
END $old$;

-- Invite reward reads the new counter.
INSERT INTO app_core.runtime_config VALUES ('miniapp_invite_reward_rules',
  '{"rules":[{"rule_key":"invitee_chat_rounds","enabled":true,"credits":100,"threshold_rounds":2}]}');
INSERT INTO miniapp_traffic.invite_relations (inviter_user_id, invitee_user_id, invite_code)
SELECT (SELECT id FROM app_core.users WHERE tg_id = '1001'), id, 'CODE' FROM app_core.users WHERE tg_id = '5001';
SELECT status AS s FROM miniapp_traffic.check_invite_chat_rounds_reward((SELECT id FROM app_core.users WHERE tg_id = '5001')) \gset below_
SELECT 1 FROM experience.increment_user_total_round((SELECT id FROM app_core.users WHERE tg_id = '5001'), 1) \g /dev/null
SELECT status AS s FROM miniapp_traffic.check_invite_chat_rounds_reward((SELECT id FROM app_core.users WHERE tg_id = '5001')) \gset granted_
SELECT status AS s FROM miniapp_traffic.check_invite_chat_rounds_reward((SELECT id FROM app_core.users WHERE tg_id = '5001')) \gset dup_
SELECT (:'below_s' = 'below_threshold' AND :'granted_s' = 'granted' AND :'dup_s' = 'duplicated') AS invite_ok \gset
\if :invite_ok
\else
  \echo 'invite reward flow wrong'
  SELECT 1 / 0;
\endif

-- Mujian/Mijing entry: brand-new account via mujian is "new"; mijing marks first entry and counts a channel click.
INSERT INTO test_fixture.r VALUES ('muj', miniapp_traffic.record_app_entry('7001', 'mujian', 'chan_a', now() - interval '1 minute'));
INSERT INTO test_fixture.r VALUES ('mij', miniapp_traffic.record_app_entry('7001', 'mijing', 'chan_a', now()));
INSERT INTO test_fixture.r VALUES ('old', miniapp_traffic.record_app_entry('1003', 'mujian', '', now()));
DO $entry$
DECLARE
  m jsonb := (SELECT r.j FROM test_fixture.r r WHERE r.k = 'muj'); mj jsonb := (SELECT r.j FROM test_fixture.r r WHERE r.k = 'mij');
  o jsonb := (SELECT r.j FROM test_fixture.r r WHERE r.k = 'old');
BEGIN
  IF m->>'eligibility' <> 'new' OR mj->>'converted' IS NULL THEN RAISE EXCEPTION 'mujian/mijing wrong: % %', m, mj; END IF;
  IF (SELECT a.miniapp_entered_at IS NULL OR a.source_id IS DISTINCT FROM 'chan_a' FROM miniapp_traffic.user_attributions a JOIN app_core.users u ON u.id = a.user_id WHERE u.tg_id = '7001') THEN
    RAISE EXCEPTION 'entry markers not written to attributions'; END IF;
  IF o->>'eligibility' <> 'existing' THEN RAISE EXCEPTION 'existing user misjudged: %', o; END IF;
  IF (SELECT sum(clicks) FROM miniapp_traffic.traffic_clicks WHERE source_id = 'chan_a' AND stat_date = CURRENT_DATE) <> 11 THEN
    RAISE EXCEPTION 'channel click not counted'; END IF;
END $entry$;
SQL
echo 'OK: expand'

# TEST-only legacy view blocks DROP COLUMN; the pre-step drops it and refuses (listing all) while other views still depend.
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE VIEW miniapp_analytics.funnel_stats AS
  SELECT count(id) FILTER (WHERE bot_entered_at IS NOT NULL) AS bot_entered_count,
    count(id) FILTER (WHERE miniapp_entered_at IS NOT NULL) AS miniapp_entered_count FROM app_core.users;
CREATE VIEW test_fixture.rounds_view AS SELECT sum(total_round) AS n FROM app_core.miniapp_user_settings;
SQL
if "${admin_psql[@]}" >/dev/null 2>&1 < "$drop_funnel"; then echo 'pre-step ignored another dependent view' >&2; exit 1; fi
"${admin_psql[@]}" -c "DROP VIEW test_fixture.rounds_view" >/dev/null
"${admin_psql[@]}" >/dev/null < "$drop_funnel"
"${admin_psql[@]}" >/dev/null < "$drop_funnel"
[[ "$("${admin_psql[@]}" -At -c "SELECT to_regclass('miniapp_analytics.funnel_stats') IS NULL")" == t ]] || { echo 'funnel_stats survived' >&2; exit 1; }

# Contract refuses while a function still reads a moved column.
"${admin_psql[@]}" -c "CREATE FUNCTION app_core.legacy_reader() RETURNS bigint LANGUAGE sql AS 'SELECT sum(u.total_round) FROM app_core.users u'" >/dev/null
if "${admin_psql[@]}" >/dev/null 2>&1 < "$contract"; then echo 'contract ran while a function reads moved columns' >&2; exit 1; fi
"${admin_psql[@]}" -c "DROP FUNCTION app_core.legacy_reader()" >/dev/null

# Release-window race leftovers (old backend wrote only to users while expand ran) are reconciled, not refused.
"${admin_psql[@]}" >/dev/null <<'SQL'
UPDATE miniapp_traffic.user_attributions SET source_id = NULL, miniapp_entered_at = NULL
  WHERE user_id = (SELECT id FROM app_core.users WHERE tg_id = '1003');
DELETE FROM miniapp_traffic.user_attributions WHERE user_id = (SELECT id FROM app_core.users WHERE tg_id = '1004');
UPDATE app_core.users SET total_round = total_round + 1 WHERE tg_id = '1005';
CREATE TABLE test_fixture.race AS
  SELECT u.tg_id, u.source_id, u.miniapp_entered_at, u.total_round,
    experience.user_total_round(u.id) AS stats_before
  FROM app_core.users u WHERE u.tg_id IN ('1003', '1004', '1005');
SQL

"${admin_psql[@]}" >/dev/null < "$contract"
"${admin_psql[@]}" >/dev/null < "$contract"
"${admin_psql[@]}" <<'SQL'
\set QUIET on
DO $after$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'app_core' AND table_name = 'users'
             AND column_name IN ('source_id', 'bot_entered_at', 'miniapp_entered_at', 'total_round', 'st_initialized_at'))
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'app_core' AND table_name = 'miniapp_user_settings' AND column_name = 'total_round')
     OR to_regprocedure('app_core.increment_user_total_round(uuid,integer)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'users_sync_attribution') THEN
    RAISE EXCEPTION 'contract left old objects';
  END IF;
  IF (SELECT count(*) FROM miniapp_traffic.traffic_daily_stats) < 20 OR (SELECT count(*) FROM cs_feed.user_profiles) < 60 THEN
    RAISE EXCEPTION 'views broken after contract'; END IF;
  IF EXISTS (SELECT 1 FROM test_fixture.race r JOIN app_core.users u ON u.tg_id = r.tg_id
             LEFT JOIN miniapp_traffic.user_attributions a ON a.user_id = u.id
             WHERE a.user_id IS NULL
                OR a.source_id IS DISTINCT FROM r.source_id
                OR a.miniapp_entered_at IS DISTINCT FROM r.miniapp_entered_at
                OR experience.user_total_round(u.id) <> GREATEST(r.total_round, r.stats_before)) THEN
    RAISE EXCEPTION 'race leftovers not reconciled';
  END IF;
  IF (SELECT stats_before FROM test_fixture.race WHERE tg_id = '1005')
     >= (SELECT total_round FROM test_fixture.race WHERE tg_id = '1005') THEN
    RAISE EXCEPTION 'fixture did not create a rounds gap';
  END IF;
END $after$;
INSERT INTO test_fixture.r VALUES ('post_enter', miniapp_traffic.enter_user('8001', 'chan_a', 'miniapp'));
INSERT INTO test_fixture.r VALUES ('post_entry', miniapp_traffic.record_app_entry('8002', 'mijing', '', now()));
SELECT 1 FROM experience.increment_user_total_round((SELECT id FROM app_core.users WHERE tg_id = '8001'), 2) \g /dev/null
DO $post$ BEGIN
  IF (SELECT j->>'source_id' FROM test_fixture.r WHERE k = 'post_enter') <> 'chan_a'
     OR (SELECT j->>'recorded' FROM test_fixture.r WHERE k = 'post_entry') <> 'true'
     OR experience.user_total_round((SELECT id FROM app_core.users WHERE tg_id = '8001')) <> 2 THEN
    RAISE EXCEPTION 'functions broken after contract'; END IF;
END $post$;
SQL
echo 'OK: 20261117_db_reorg_p3a_user_attributions.sql + _contract'
