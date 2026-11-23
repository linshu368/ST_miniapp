#!/usr/bin/env bash
# Disposable PG17 + PostgREST only. No remote URI, host ports beyond 127.0.0.1, or real user data.
#
# 阶段 7 第一批命名统一（20261123_db_reorg_p7a_naming.sql）的本地验证：
#   old_db    —— 不跑迁移，用旧名字跑场景；
#   new_db    —— 跑迁移，用新名字跑同一组场景；
#   compat_db —— 跑迁移，仍用旧名字跑（旧后端 / Grafana 在切换前的样子）；
# 三边导出逐行相同（审计日志里的 schema 名按新旧映射）。另外检查：改名结果、函数正文、定时任务、
# PostgREST 配置、兼容层权限；PostgREST 用新旧两个 profile 读写结果一致；重跑跳过；新名字被占用时拒绝。
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
migration="$repo_root/packages/shared/migrations/20261123_db_reorg_p7a_naming.sql"
contract="$repo_root/packages/shared/migrations/20261123_db_reorg_p7a_naming_contract.sql"
net="p7a-net-$$"
pg="p7a-pg-$$"
rest="p7a-rest-$$"
out_dir=$(mktemp -d)
cleanup() {
  docker rm -f "$rest" "$pg" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  rm -rf "$out_dir"
}
trap cleanup EXIT

docker network create "$net" >/dev/null
docker run -d --rm --network "$net" --name "$pg" -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$pg" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$pg" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done

su_psql() { local db=$1; shift; docker exec -i "$pg" psql -X -q -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
app_psql() { local db=$1; shift; docker exec -i "$pg" psql -X -q -U app_admin -d "$db" -v ON_ERROR_STOP=1 "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

su_psql postgres >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN CREATEROLE;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE first_token_metrics_reader NOLOGIN;
CREATE ROLE grafana_cloud LOGIN IN ROLE first_token_metrics_reader;
CREATE ROLE cs_persona_reader NOLOGIN;
CREATE ROLE authenticator LOGIN NOINHERIT;
GRANT anon, authenticated, service_role TO authenticator;
GRANT authenticator TO app_admin WITH ADMIN OPTION, INHERIT FALSE, SET FALSE;
-- 生产 postgres 不是超级用户，靠 Supabase 的 supautils 才能改 authenticator 的 pgrst.*（20261117 已在生产这样改过）；本地用参数授权模拟
GRANT SET ON PARAMETER pgrst.db_schemas, pgrst.db_extra_search_path TO app_admin;
ALTER ROLE authenticator SET pgrst.db_schemas = 'graphql_public, miniapp_analytics, miniapp_traffic, admin, app_core, miniapp_features, experience, billing, drama_archive, media_plaza';
ALTER ROLE authenticator SET pgrst.db_extra_search_path = 'public, graphql_public, miniapp_traffic';
SQL

fixture() {
  local db=$1 with_cron=${2:-cron}
  su_psql postgres -c "CREATE DATABASE $db OWNER app_admin" >/dev/null
  # pg_cron 的最小替身：任务表归超级用户，app_admin 只能经函数改（与生产一致）。TEST 库没装 pg_cron（nocron_db）。
  [[ "$with_cron" == cron ]] && su_psql "$db" >/dev/null <<'SQL'
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text, schedule text NOT NULL, command text NOT NULL,
  username text NOT NULL DEFAULT current_user, active boolean NOT NULL DEFAULT true);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE sql SECURITY DEFINER AS
  $$ INSERT INTO cron.job(jobname, schedule, command, username) VALUES (job_name, schedule, command, session_user) RETURNING jobid $$;
CREATE FUNCTION cron.unschedule(job_id bigint) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS
  $$ DELETE FROM cron.job WHERE jobid = job_id RETURNING true $$;
CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL,
  database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL) RETURNS void LANGUAGE sql SECURITY DEFINER AS
  $$ UPDATE cron.job SET schedule = coalesce($2, cron.job.schedule), command = coalesce($3, cron.job.command),
       active = coalesce($6, cron.job.active) WHERE jobid = job_id $$;
GRANT USAGE ON SCHEMA cron TO app_admin;
GRANT SELECT ON cron.job TO app_admin;
INSERT INTO cron.job(jobname, schedule, command, username) VALUES
  ('grafana_core_recent_30m', '7,37 * * * *', E'SET statement_timeout=''20s''; SET lock_timeout=''1s'';\nSELECT miniapp_analytics.refresh_grafana_core_day((now() AT TIME ZONE ''Asia/Shanghai'')::date);', 'app_admin'),
  ('grafana_core_yesterday_close', '17 16-22 * * *', E'SET statement_timeout=''30s'';\nSELECT miniapp_analytics.refresh_grafana_core_day((now() AT TIME ZONE ''Asia/Shanghai'')::date-1);', 'app_admin'),
  ('chat_prompt_observations_retention', '17 * * * *', 'SELECT 1', 'app_admin');
UPDATE cron.job SET active = false WHERE jobname = 'grafana_core_yesterday_close';
SQL
  app_psql "$db" >/dev/null <<'SQL'
CREATE SCHEMA app_core; CREATE SCHEMA billing; CREATE SCHEMA admin; CREATE SCHEMA ops;
CREATE SCHEMA miniapp_analytics; CREATE SCHEMA miniapp_features; CREATE SCHEMA miniapp_traffic;
CREATE SCHEMA graphql_public; CREATE SCHEMA experience; CREATE SCHEMA drama_archive; CREATE SCHEMA media_plaza;
GRANT USAGE ON SCHEMA app_core, billing, admin, ops, miniapp_features, miniapp_traffic TO service_role;
GRANT USAGE ON SCHEMA miniapp_analytics TO service_role, first_token_metrics_reader, cs_persona_reader;
GRANT USAGE ON SCHEMA miniapp_features TO authenticated;

CREATE TABLE app_core.users (id uuid PRIMARY KEY);
CREATE TABLE app_core.characters (id uuid PRIMARY KEY);
CREATE TABLE admin.audit_logs (id bigserial PRIMARY KEY, action text, target_schema text, target_table text, target_id text);
CREATE TABLE ops.llm_calls (id bigserial PRIMARY KEY, lane text, cost_usd numeric);
INSERT INTO app_core.users VALUES ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b');
INSERT INTO app_core.characters VALUES ('00000000-0000-0000-0000-0000000000c1'), ('00000000-0000-0000-0000-0000000000c2');
INSERT INTO ops.llm_calls(lane, cost_usd) VALUES ('paid', 0.01), ('free_zone', 0.002);

-- analytics
CREATE TABLE miniapp_analytics.grafana_core_daily (
  metric_date date NOT NULL, metric_scope text NOT NULL, model_id text NOT NULL DEFAULT '',
  requests integer NOT NULL DEFAULT 0, refreshed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grafana_core_daily_pkey PRIMARY KEY (metric_date, metric_scope, model_id),
  CONSTRAINT grafana_core_daily_metric_scope_check CHECK (metric_scope IN ('overall', 'model')),
  CONSTRAINT grafana_core_daily_check CHECK (requests >= 0));
ALTER TABLE miniapp_analytics.grafana_core_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY grafana_core_read ON miniapp_analytics.grafana_core_daily FOR SELECT TO first_token_metrics_reader USING (metric_scope = 'overall');
GRANT SELECT ON miniapp_analytics.grafana_core_daily TO first_token_metrics_reader;
COMMENT ON TABLE miniapp_analytics.grafana_core_daily IS '看板日汇总，由 miniapp_analytics.refresh_grafana_core_day 刷新';
CREATE TABLE miniapp_analytics.drama_survey_responses (user_id uuid PRIMARY KEY, answer text NOT NULL);
GRANT ALL ON miniapp_analytics.drama_survey_responses TO service_role;
CREATE VIEW miniapp_analytics.llm_call_costs AS SELECT lane, sum(cost_usd) AS cost_usd FROM ops.llm_calls GROUP BY lane;
GRANT SELECT ON miniapp_analytics.llm_call_costs TO first_token_metrics_reader, service_role;
CREATE FUNCTION miniapp_analytics.refresh_grafana_core_day(p_day date) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog' AS $$
BEGIN
  INSERT INTO miniapp_analytics.grafana_core_daily(metric_date, metric_scope, requests)
  SELECT p_day, 'overall', count(*)::int FROM app_core.users
  ON CONFLICT ON CONSTRAINT grafana_core_daily_pkey DO UPDATE SET requests = EXCLUDED.requests;
  INSERT INTO miniapp_analytics.grafana_core_daily(metric_date, metric_scope, model_id, requests)
  VALUES (p_day, 'model', 'm1', 1)
  ON CONFLICT (metric_date, metric_scope, model_id) DO UPDATE SET requests = miniapp_analytics.grafana_core_daily.requests + 1;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION miniapp_analytics.refresh_grafana_core_day(date) FROM PUBLIC;

-- features
CREATE TABLE miniapp_features.user_marks (user_id uuid NOT NULL, mark_key text NOT NULL, count integer NOT NULL DEFAULT 1,
  first_at timestamptz NOT NULL DEFAULT now(), last_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, mark_key));
ALTER TABLE miniapp_features.user_marks ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_marks ON miniapp_features.user_marks FOR SELECT TO authenticated USING (user_id = '00000000-0000-0000-0000-00000000000a');
GRANT ALL ON miniapp_features.user_marks TO service_role;
GRANT SELECT ON miniapp_features.user_marks TO authenticated;
CREATE FUNCTION miniapp_features.touch_user_mark(p_user_id uuid, p_mark_key text)
RETURNS TABLE(count integer, first_at timestamptz, last_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog' AS $$
BEGIN
  RETURN QUERY INSERT INTO miniapp_features.user_marks AS m(user_id, mark_key) VALUES (p_user_id, p_mark_key)
  ON CONFLICT (user_id, mark_key) DO UPDATE SET count = m.count + 1, last_at = now()
  RETURNING m.count, m.first_at, m.last_at;
END $$;
CREATE TABLE miniapp_features.notifications (id bigserial PRIMARY KEY, title text NOT NULL, published boolean NOT NULL DEFAULT false);
GRANT ALL ON miniapp_features.notifications TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA miniapp_features TO service_role;
CREATE TABLE miniapp_features.telegram_community_update_receipts (
  update_id bigint PRIMARY KEY, community_chat_id text NOT NULL, telegram_user_id text NOT NULL,
  eligible boolean NOT NULL DEFAULT false, result text,
  CONSTRAINT telegram_community_update_receipts_result_check CHECK (result IS NULL OR result IN ('granted', 'unmatched', 'failed')),
  CONSTRAINT telegram_community_update_receipts_telegram_user_id_check CHECK (telegram_user_id ~ '^[0-9]+$'));
CREATE INDEX telegram_community_receipt_eligible_idx ON miniapp_features.telegram_community_update_receipts (community_chat_id, telegram_user_id) WHERE eligible;
GRANT ALL ON miniapp_features.telegram_community_update_receipts TO service_role;
CREATE TABLE miniapp_features.community_reward_claims (user_id uuid PRIMARY KEY,
  telegram_update_id bigint NOT NULL CONSTRAINT community_reward_claims_telegram_update_id_fkey
    REFERENCES miniapp_features.telegram_community_update_receipts(update_id), credits integer NOT NULL);
GRANT ALL ON miniapp_features.community_reward_claims TO service_role;
CREATE FUNCTION miniapp_features.grant_community_join_reward(p_user_id uuid, p_update_id bigint)
RETURNS TABLE(status text, credits integer, granted_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM miniapp_features.telegram_community_update_receipts r WHERE r.update_id = p_update_id AND r.eligible) THEN
    RETURN QUERY SELECT 'not_eligible'::text, 0, NULL::timestamptz; RETURN;
  END IF;
  INSERT INTO miniapp_features.community_reward_claims(user_id, telegram_update_id, credits) VALUES (p_user_id, p_update_id, 30)
  ON CONFLICT (user_id) DO NOTHING;
  IF NOT FOUND THEN RETURN QUERY SELECT 'already_claimed'::text, 0, NULL::timestamptz; RETURN; END IF;
  UPDATE miniapp_features.telegram_community_update_receipts SET result = 'granted' WHERE update_id = p_update_id;
  RETURN QUERY SELECT 'granted'::text, 30, now();
END $$;
CREATE TABLE miniapp_features.user_lobby_recommendations (user_id uuid NOT NULL, state jsonb NOT NULL, updated_at timestamptz NOT NULL,
  CONSTRAINT user_lobby_recommendations_pkey PRIMARY KEY (user_id),
  CONSTRAINT user_lobby_recommendations_user_fkey FOREIGN KEY (user_id) REFERENCES app_core.users(id),
  CONSTRAINT user_lobby_recommendations_state_check CHECK (jsonb_typeof(state) = 'object'));
CREATE TABLE miniapp_features.user_character_exposures (user_id uuid NOT NULL, character_id uuid NOT NULL,
  last_seen_at timestamptz NOT NULL, seen_batch_ids uuid[] NOT NULL,
  CONSTRAINT user_character_exposures_pkey PRIMARY KEY (user_id, character_id),
  CONSTRAINT user_character_exposures_user_fkey FOREIGN KEY (user_id) REFERENCES app_core.users(id),
  CONSTRAINT user_character_exposures_character_fkey FOREIGN KEY (character_id) REFERENCES app_core.characters(id),
  CONSTRAINT user_character_exposures_batch_count_check CHECK (cardinality(seen_batch_ids) BETWEEN 1 AND 3));
CREATE INDEX user_character_exposures_character_idx ON miniapp_features.user_character_exposures (character_id);
COMMENT ON COLUMN miniapp_features.user_character_exposures.character_id IS 'soft ref → app_core.characters；见 miniapp_features.user_lobby_recommendations';
CREATE TABLE miniapp_features.character_ranking_scores (character_id uuid NOT NULL, score numeric, trusted_score numeric, trusted_at timestamptz,
  CONSTRAINT character_ranking_scores_pkey PRIMARY KEY (character_id),
  CONSTRAINT character_ranking_scores_character_id_fkey FOREIGN KEY (character_id) REFERENCES app_core.characters(id),
  CONSTRAINT character_ranking_scores_trusted_check CHECK (trusted_score IS NULL OR trusted_at IS NOT NULL));
CREATE INDEX idx_character_ranking_scores_score ON miniapp_features.character_ranking_scores (score DESC);
CREATE TABLE miniapp_features.lobby_ranking_refresh_state (singleton boolean PRIMARY KEY CHECK (singleton), completed_at timestamptz);
CREATE TABLE miniapp_features.character_comments (id bigserial PRIMARY KEY, character_id uuid NOT NULL, body text NOT NULL);
GRANT ALL ON miniapp_features.character_comments TO service_role;
CREATE FUNCTION miniapp_features.create_character_comment(p_character_id uuid, p_body text)
RETURNS SETOF miniapp_features.character_comments LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog' AS $$
  INSERT INTO miniapp_features.character_comments(character_id, body) VALUES (p_character_id, p_body) RETURNING *
$$;
CREATE FUNCTION miniapp_features.delete_character_comment(p_id bigint) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog' AS $$ DELETE FROM miniapp_features.character_comments WHERE id = p_id $$;
CREATE FUNCTION miniapp_features.vip_expiry_reminder_window() RETURNS text LANGUAGE sql STABLE AS $$ SELECT '24h'::text $$;
CREATE VIEW miniapp_analytics.v_card_quality_session AS
  SELECT s.character_id, s.score FROM miniapp_features.character_ranking_scores s WHERE s.trusted_at IS NOT NULL;
GRANT SELECT ON miniapp_analytics.v_card_quality_session TO first_token_metrics_reader;
GRANT ALL ON ALL TABLES IN SCHEMA miniapp_features TO service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA miniapp_features FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA miniapp_features TO service_role;
GRANT EXECUTE ON FUNCTION miniapp_features.vip_expiry_reminder_window() TO authenticated;

-- traffic
CREATE TABLE miniapp_traffic.invite_codes (user_id uuid PRIMARY KEY, code text NOT NULL UNIQUE);
CREATE TABLE miniapp_traffic.botlinks (id bigint PRIMARY KEY, clicks integer NOT NULL DEFAULT 0);
INSERT INTO miniapp_traffic.botlinks VALUES (1, 0);
GRANT ALL ON ALL TABLES IN SCHEMA miniapp_traffic TO service_role;
CREATE FUNCTION miniapp_traffic.ensure_invite_code(p_user_id uuid) RETURNS TABLE(code text, first_visit boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog' AS $$
BEGIN
  INSERT INTO miniapp_traffic.invite_codes(user_id, code) VALUES (p_user_id, 'C' || left(p_user_id::text, 4) || right(p_user_id::text, 2))
  ON CONFLICT (user_id) DO NOTHING;
  RETURN QUERY SELECT i.code, FOUND FROM miniapp_traffic.invite_codes i WHERE i.user_id = p_user_id;
END $$;
CREATE FUNCTION miniapp_traffic.increment_click(p_id bigint) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'miniapp_traffic', 'public' AS $$ UPDATE botlinks SET clicks = clicks + 1 WHERE id = p_id $$;
CREATE VIEW miniapp_traffic.traffic_daily_stats AS SELECT sum(clicks) AS clicks FROM miniapp_traffic.botlinks;
GRANT SELECT ON miniapp_traffic.traffic_daily_stats TO service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA miniapp_traffic FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA miniapp_traffic TO service_role;

-- 其他 schema 里提旧名字的函数（审计字面量 / 跨域写）
CREATE FUNCTION admin.create_announcement(p_title text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog' AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO miniapp_features.notifications(title) VALUES (p_title) RETURNING id INTO v_id;
  INSERT INTO admin.audit_logs(action, target_schema, target_table, target_id)
  VALUES ('announcement.create', 'miniapp_features', 'notifications', v_id::text);
  RETURN v_id;
END $$;
CREATE FUNCTION billing.submit_drama_survey(p_user_id uuid, p_answer text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog' AS $$
BEGIN
  INSERT INTO miniapp_analytics.drama_survey_responses(user_id, answer) VALUES (p_user_id, p_answer)
  ON CONFLICT (user_id) DO UPDATE SET answer = EXCLUDED.answer;
  RETURN jsonb_build_object('ok', true);
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA admin, billing TO service_role;
SQL
}

for db in old_db new_db compat_db drift_db; do fixture "$db"; done
fixture nocron_db nocron

echo "== migrate new_db / compat_db (as non-superuser app_admin)"
for db in new_db compat_db; do
  app_psql "$db" -f - <"$migration" >"$out_dir/$db.migrate.log" 2>&1 || { cat "$out_dir/$db.migrate.log"; fail "migration failed on $db"; }
done
grep -q 'p7a-naming: renamed 3 schemas and 6 relations, rewrote 9 functions; compat layer has 16 views and 8 forwarders' "$out_dir/new_db.migrate.log" ||
  { cat "$out_dir/new_db.migrate.log"; fail 'unexpected summary NOTICE'; }
grep -q "authenticator pgrst.db_schemas was" "$out_dir/new_db.migrate.log" || fail 'expected old db_schemas NOTICE'

echo "== structure"
struct=$(app_psql new_db -At <<'SQL'
SELECT string_agg(nspname, ',' ORDER BY nspname COLLATE "C") FROM pg_namespace WHERE nspname IN ('analytics','features','traffic','miniapp_analytics','miniapp_features','miniapp_traffic');
SELECT string_agg(c.relnamespace::regnamespace::text || '.' || c.relname || ':' || c.relkind::text, ',' ORDER BY c.relnamespace::regnamespace::text || '.' || c.relname COLLATE "C")
  FROM pg_class c WHERE c.relnamespace::regnamespace::text IN ('analytics','features') AND c.relname IN
  ('core_daily','card_quality_sessions','community_update_receipts','lobby_recommendations','lobby_ranking_scores','lobby_exposures');
SELECT string_agg(conname, ',' ORDER BY conname COLLATE "C") FROM pg_constraint WHERE connamespace = 'features'::regnamespace OR connamespace = 'analytics'::regnamespace;
SELECT string_agg(relname, ',' ORDER BY relname COLLATE "C") FROM pg_class WHERE relkind = 'i' AND relnamespace IN ('features'::regnamespace, 'analytics'::regnamespace);
SELECT string_agg(polname, ',') FROM pg_policy WHERE polrelid = 'analytics.core_daily'::regclass;
SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'traffic.increment_click(bigint)'::regprocedure;
SELECT string_agg(jobname || '|' || active || '|' || command, E'\n' ORDER BY jobname COLLATE "C") FROM cron.job;
SELECT string_agg(c, E'\n' ORDER BY c COLLATE "C") FROM pg_roles, unnest(rolconfig) c WHERE rolname = 'authenticator';
SELECT obj_description('analytics.core_daily'::regclass, 'pg_class');
SELECT col_description('features.lobby_exposures'::regclass, 2);
SELECT coalesce(string_agg(p.oid::regprocedure::text, ','), '0') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('admin','billing','analytics','features','traffic') AND p.prosrc ~ '\mminiapp_|grafana_core_daily|telegram_community|user_lobby|character_ranking_scores|user_character_exposures';
SELECT has_table_privilege('grafana_cloud', 'miniapp_analytics.grafana_core_daily', 'SELECT')::text
  || has_table_privilege('service_role', 'miniapp_features.telegram_community_update_receipts', 'INSERT')::text
  || has_function_privilege('service_role', 'miniapp_features.touch_user_mark(uuid,text)', 'EXECUTE')::text
  || has_function_privilege('anon', 'miniapp_features.touch_user_mark(uuid,text)', 'EXECUTE')::text
  || has_function_privilege('authenticated', 'miniapp_features.vip_expiry_reminder_window()', 'EXECUTE')::text
  || has_schema_privilege('cs_persona_reader', 'miniapp_analytics', 'USAGE')::text;
SQL
)
expected_struct=$(cat <<'EOF'
analytics,features,miniapp_analytics,miniapp_features,miniapp_traffic,traffic
analytics.card_quality_sessions:v,analytics.core_daily:r,features.community_update_receipts:r,features.lobby_exposures:r,features.lobby_ranking_scores:r,features.lobby_recommendations:r
character_comments_pkey,community_reward_claims_pkey,community_reward_claims_telegram_update_id_fkey,community_update_receipts_pkey,community_update_receipts_result_check,community_update_receipts_telegram_user_id_check,core_daily_check,core_daily_metric_scope_check,core_daily_pkey,drama_survey_responses_pkey,lobby_exposures_batch_count_check,lobby_exposures_character_fkey,lobby_exposures_pkey,lobby_exposures_user_fkey,lobby_ranking_refresh_state_pkey,lobby_ranking_refresh_state_singleton_check,lobby_ranking_scores_character_id_fkey,lobby_ranking_scores_pkey,lobby_ranking_scores_trusted_check,lobby_recommendations_pkey,lobby_recommendations_state_check,lobby_recommendations_user_fkey,notifications_pkey,user_marks_pkey
character_comments_pkey,community_receipt_eligible_idx,community_reward_claims_pkey,community_update_receipts_pkey,core_daily_pkey,drama_survey_responses_pkey,idx_lobby_ranking_scores_score,lobby_exposures_character_idx,lobby_exposures_pkey,lobby_ranking_refresh_state_pkey,lobby_ranking_scores_pkey,lobby_recommendations_pkey,notifications_pkey,user_marks_pkey
core_daily_read
search_path=traffic, public
chat_prompt_observations_retention|true|SELECT 1
core_daily_recent_30m|true|SET statement_timeout='20s'; SET lock_timeout='1s';
SELECT analytics.refresh_core_daily((now() AT TIME ZONE 'Asia/Shanghai')::date);
core_daily_yesterday_close|false|SET statement_timeout='30s';
SELECT analytics.refresh_core_daily((now() AT TIME ZONE 'Asia/Shanghai')::date-1);
pgrst.db_extra_search_path=public, graphql_public, traffic, miniapp_traffic
pgrst.db_schemas=graphql_public, analytics, miniapp_analytics, traffic, miniapp_traffic, admin, app_core, features, miniapp_features, experience, billing, drama_archive, media_plaza
看板日汇总，由 analytics.refresh_core_daily 刷新
soft ref → app_core.characters；见 features.lobby_recommendations
0
truetruetruefalsetruetrue
EOF
)
if [[ "$struct" != "$expected_struct" ]]; then
  diff <(echo "$expected_struct") <(echo "$struct") || true
  fail 'structure differs from expectation'
fi

# 同一组场景：$1 = 名字风格（old / new），写给 psql 的 SQL 文本
scenario() {
  local A F T CORE RECS EXPO SCORES RECEIPTS REFRESH
  if [[ $1 == old ]]; then
    A=miniapp_analytics F=miniapp_features T=miniapp_traffic CORE=grafana_core_daily RECS=user_lobby_recommendations
    EXPO=user_character_exposures SCORES=character_ranking_scores RECEIPTS=telegram_community_update_receipts REFRESH=refresh_grafana_core_day
  else
    A=analytics F=features T=traffic CORE=core_daily RECS=lobby_recommendations
    EXPO=lobby_exposures SCORES=lobby_ranking_scores RECEIPTS=community_update_receipts REFRESH=refresh_core_daily
  fi
  cat <<SQL
\\pset format unaligned
\\pset tuples_only on
SET ROLE service_role;
SELECT 's1', count FROM $F.touch_user_mark('00000000-0000-0000-0000-00000000000a', 'growth.vip_prompt');
SELECT 's2', count FROM $F.touch_user_mark('00000000-0000-0000-0000-00000000000a', 'growth.vip_prompt');
SELECT 's3', code, first_visit FROM $T.ensure_invite_code('00000000-0000-0000-0000-00000000000a');
SELECT 's4', code, first_visit FROM $T.ensure_invite_code('00000000-0000-0000-0000-00000000000a');
SELECT 's5', $T.increment_click(1);
SELECT 's6', clicks FROM $T.traffic_daily_stats;
SELECT 's7', character_id, body FROM $F.create_character_comment('00000000-0000-0000-0000-0000000000c1', 'hi');
SELECT 's8', $F.delete_character_comment(1);
SELECT 's9', billing.submit_drama_survey('00000000-0000-0000-0000-00000000000b', 'yes');
SELECT 's10', admin.create_announcement('上新');
INSERT INTO $F.$RECEIPTS (update_id, community_chat_id, telegram_user_id, eligible) VALUES (501, '-100', '42', true);
INSERT INTO $F.$RECEIPTS (update_id, community_chat_id, telegram_user_id) VALUES (502, '-100', '43') ON CONFLICT DO NOTHING;
UPDATE $F.$RECEIPTS SET result = 'unmatched' WHERE update_id = 502;
SELECT 's11', status, credits FROM $F.grant_community_join_reward('00000000-0000-0000-0000-00000000000a', 501);
SELECT 's12', status, credits FROM $F.grant_community_join_reward('00000000-0000-0000-0000-00000000000a', 501);
SELECT 's13', $F.vip_expiry_reminder_window();
RESET ROLE;
-- 后端经 Prisma 的直写 SQL（原样照抄写法）
INSERT INTO $F.$RECS(user_id, state, updated_at) VALUES ('00000000-0000-0000-0000-00000000000a', '{"v":1}', '2026-11-23 10:00+08')
ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at;
INSERT INTO $F.$RECS(user_id, state, updated_at) VALUES ('00000000-0000-0000-0000-00000000000a', '{"v":2}', '2026-11-23 10:01+08')
ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at;
SELECT 's14', state FROM $F.$RECS WHERE user_id = '00000000-0000-0000-0000-00000000000a' FOR UPDATE;
INSERT INTO $F.$EXPO(user_id, character_id, last_seen_at, seen_batch_ids)
SELECT '00000000-0000-0000-0000-00000000000a', t.id::uuid, '2026-11-23 10:00+08', ARRAY['00000000-0000-0000-0000-0000000000b1'::uuid]
FROM jsonb_array_elements_text('["00000000-0000-0000-0000-0000000000c1","00000000-0000-0000-0000-0000000000c2"]'::jsonb) AS t(id)
ON CONFLICT (user_id, character_id) DO UPDATE SET
  last_seen_at = GREATEST($F.$EXPO.last_seen_at, EXCLUDED.last_seen_at),
  seen_batch_ids = (EXCLUDED.seen_batch_ids || $F.$EXPO.seen_batch_ids)[1:3]
WHERE NOT ('00000000-0000-0000-0000-0000000000b1'::uuid = ANY($F.$EXPO.seen_batch_ids));
INSERT INTO $F.$EXPO(user_id, character_id, last_seen_at, seen_batch_ids)
SELECT '00000000-0000-0000-0000-00000000000a', t.id::uuid, '2026-11-23 11:00+08', ARRAY['00000000-0000-0000-0000-0000000000b2'::uuid]
FROM jsonb_array_elements_text('["00000000-0000-0000-0000-0000000000c1"]'::jsonb) AS t(id)
ON CONFLICT (user_id, character_id) DO UPDATE SET
  last_seen_at = GREATEST($F.$EXPO.last_seen_at, EXCLUDED.last_seen_at),
  seen_batch_ids = (EXCLUDED.seen_batch_ids || $F.$EXPO.seen_batch_ids)[1:3]
WHERE NOT ('00000000-0000-0000-0000-0000000000b2'::uuid = ANY($F.$EXPO.seen_batch_ids));
INSERT INTO $F.$SCORES (character_id, score, trusted_score, trusted_at)
SELECT t.character_id, t.score, t.score, '2026-11-23 10:00+08' FROM jsonb_to_recordset('[{"character_id":"00000000-0000-0000-0000-0000000000c1","score":0.9},{"character_id":"00000000-0000-0000-0000-0000000000c2","score":0.4}]'::jsonb) AS t(character_id uuid, score numeric)
ON CONFLICT (character_id) DO UPDATE SET score = EXCLUDED.score,
  trusted_score = COALESCE(EXCLUDED.trusted_score, $F.$SCORES.trusted_score);
UPDATE $F.$SCORES AS target SET score = 0.5 WHERE target.character_id = '00000000-0000-0000-0000-0000000000c2';
DELETE FROM $F.$SCORES AS target WHERE target.score < 0.6 AND NOT EXISTS (SELECT 1 WHERE false);
INSERT INTO $F.lobby_ranking_refresh_state (singleton, completed_at) VALUES (true, '2026-11-23 10:00+08')
ON CONFLICT (singleton) DO UPDATE SET completed_at = EXCLUDED.completed_at;
SELECT 's15', $A.$REFRESH('2026-11-22');
SELECT 's16', $A.$REFRESH('2026-11-22');
SET ROLE grafana_cloud;
SELECT 's17', metric_scope, requests FROM $A.$CORE ORDER BY 2;
SELECT 's18', lane, cost_usd FROM $A.llm_call_costs ORDER BY 2;
SELECT 's19', character_id, score FROM $A.$( [[ $1 == old ]] && echo v_card_quality_session || echo card_quality_sessions ) ORDER BY 2;
RESET ROLE;
SET ROLE authenticated;
SELECT 's20', count(*) FROM $F.user_marks;
RESET ROLE;
SQL
}

export_state() {
  local db=$1 style=$2 A F T CORE RECS EXPO SCORES RECEIPTS
  if [[ $style == old ]]; then
    A=miniapp_analytics F=miniapp_features T=miniapp_traffic CORE=grafana_core_daily RECS=user_lobby_recommendations
    EXPO=user_character_exposures SCORES=character_ranking_scores RECEIPTS=telegram_community_update_receipts
  else
    A=analytics F=features T=traffic CORE=core_daily RECS=lobby_recommendations
    EXPO=lobby_exposures SCORES=lobby_ranking_scores RECEIPTS=community_update_receipts
  fi
  su_psql "$db" -At <<SQL
SELECT 'marks', user_id, mark_key, count FROM $F.user_marks ORDER BY 2, 3;
SELECT 'notif', id, title, published FROM $F.notifications ORDER BY 2;
SELECT 'audit', action, regexp_replace(target_schema, '^miniapp_', ''), target_table, target_id FROM admin.audit_logs ORDER BY 2, 5;
SELECT 'receipt', update_id, eligible, result FROM $F.$RECEIPTS ORDER BY 2;
SELECT 'claim', user_id, telegram_update_id, credits FROM $F.community_reward_claims ORDER BY 2;
SELECT 'recs', user_id, state::text, updated_at FROM $F.$RECS ORDER BY 2;
SELECT 'expo', user_id, character_id, last_seen_at, seen_batch_ids::text FROM $F.$EXPO ORDER BY 2, 3;
SELECT 'score', character_id, score, trusted_score FROM $F.$SCORES ORDER BY 2;
SELECT 'refresh', singleton, completed_at FROM $F.lobby_ranking_refresh_state;
SELECT 'comment', id, character_id, body FROM $F.character_comments ORDER BY 2;
SELECT 'core', metric_date, metric_scope, model_id, requests FROM $A.$CORE ORDER BY 2, 3, 4;
SELECT 'survey', user_id, answer FROM $A.drama_survey_responses ORDER BY 2;
SELECT 'invite', user_id, code FROM $T.invite_codes ORDER BY 2;
SELECT 'click', id, clicks FROM $T.botlinks ORDER BY 2;
SQL
}

echo "== scenarios"
scenario old | su_psql old_db >"$out_dir/old.out"
scenario new | su_psql new_db >"$out_dir/new.out"
scenario old | su_psql compat_db >"$out_dir/compat.out"
export_state old_db old >"$out_dir/old.state"
export_state new_db new >"$out_dir/new.state"
export_state compat_db new >"$out_dir/compat.state"
diff "$out_dir/old.out" "$out_dir/new.out" || fail 'scenario outputs differ (old vs new names)'
diff "$out_dir/old.out" "$out_dir/compat.out" || fail 'scenario outputs differ (old vs compat layer)'
diff "$out_dir/old.state" "$out_dir/new.state" || fail 'state differs (old vs new names)'
diff "$out_dir/old.state" "$out_dir/compat.state" || fail 'state differs (old vs compat layer)'
for k in 's1|1' 's2|2' 's3|' 's11|granted|30' 's12|already_claimed|0' 's16|t' 's17|overall|2' 's20|1'; do
  grep -q "^$k" "$out_dir/old.out" || fail "expected scenario line $k"
done
grep -q "^s17|model" "$out_dir/old.out" && fail 'RLS should hide model rows from grafana'
grep -q "^audit|announcement.create|features|notifications" "$out_dir/new.state" || fail 'audit literal not rewritten'
su_psql new_db -At -c "SELECT target_schema FROM admin.audit_logs" | grep -qx features || fail 'new audit rows should name features'
echo "scenario outputs: $(wc -l <"$out_dir/old.out") lines, state rows: $(wc -l <"$out_dir/old.state") — identical across old / new / compat"

echo "== PostgREST: old and new profiles"
docker run -d --rm --network "$net" --name "$rest" \
  -e PGRST_DB_URI="postgres://authenticator@$pg:5432/compat_db" -e PGRST_DB_ANON_ROLE=anon -e PGRST_DB_CONFIG=true \
  -e PGRST_JWT_SECRET="p7a-naming-local-fixture-only-jwt-secret-32chars" \
  -p 127.0.0.1::3000 postgrest/postgrest:v12.2.12 >/dev/null
port=$(docker port "$rest" 3000/tcp | head -1 | awk -F: '{print $NF}')
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$port/" -H 'Accept-Profile: features' >/dev/null 2>&1 && break; sleep 1; done
token=$(python3 - <<'PY'
import base64, hashlib, hmac, json
enc = lambda d: base64.urlsafe_b64encode(json.dumps(d, separators=(",", ":")).encode()).rstrip(b"=")
head, body = enc({"alg": "HS256", "typ": "JWT"}), enc({"role": "service_role"})
sig = base64.urlsafe_b64encode(hmac.new(b"p7a-naming-local-fixture-only-jwt-secret-32chars", head + b"." + body, hashlib.sha256).digest()).rstrip(b"=")
print((head + b"." + body + b"." + sig).decode())
PY
)
req() { curl -s -H "Authorization: Bearer $token" -H 'Content-Type: application/json' "$@"; }
u="http://127.0.0.1:$port"
o1=$(req -H 'Accept-Profile: miniapp_features' "$u/user_lobby_recommendations?select=state")
n1=$(req -H 'Accept-Profile: features' "$u/lobby_recommendations?select=state")
[[ "$o1" == "$n1" && "$o1" == '[{"state":{"v": 2}}]' ]] || fail "GET differs: $o1 vs $n1"
o2=$(req -H 'Content-Profile: miniapp_features' -H 'Prefer: resolution=merge-duplicates,return=representation' -X POST \
  "$u/user_lobby_recommendations?on_conflict=user_id&select=state" \
  -d '{"user_id":"00000000-0000-0000-0000-00000000000a","state":{"v":3},"updated_at":"2026-11-23T03:00:00Z"}')
[[ "$o2" == '[{"state":{"v": 3}}]' ]] || fail "upsert via old profile: $o2"
o3=$(req -H 'Content-Profile: miniapp_features' -H 'Prefer: return=representation' -X POST "$u/telegram_community_update_receipts?select=update_id,result" \
  -d '{"update_id":503,"community_chat_id":"-100","telegram_user_id":"44"}')
n3=$(req -H 'Content-Profile: features' -H 'Prefer: return=representation' -X PATCH "$u/community_update_receipts?update_id=eq.503&select=update_id,result" \
  -d '{"result":"failed"}')
[[ "$o3" == '[{"update_id":503,"result":null}]' && "$n3" == '[{"update_id":503,"result":"failed"}]' ]] || fail "receipt insert/patch: $o3 / $n3"
o4=$(req -H 'Content-Profile: miniapp_features' -X POST "$u/rpc/touch_user_mark" -d '{"p_user_id":"00000000-0000-0000-0000-00000000000b","p_mark_key":"k"}' | python3 -c 'import json,sys; print([r["count"] for r in json.load(sys.stdin)])')
n4=$(req -H 'Content-Profile: features' -X POST "$u/rpc/touch_user_mark" -d '{"p_user_id":"00000000-0000-0000-0000-00000000000b","p_mark_key":"k"}' | python3 -c 'import json,sys; print([r["count"] for r in json.load(sys.stdin)])')
[[ "$o4" == '[1]' && "$n4" == '[2]' ]] || fail "rpc touch_user_mark old/new: $o4 / $n4"
o5=$(req -H 'Content-Profile: miniapp_traffic' -X POST "$u/rpc/ensure_invite_code" -d '{"p_user_id":"00000000-0000-0000-0000-00000000000b"}')
n5=$(req -H 'Content-Profile: traffic' -X POST "$u/rpc/ensure_invite_code" -d '{"p_user_id":"00000000-0000-0000-0000-00000000000b"}')
[[ "$o5" == '[{"code":"C00000b","first_visit":true}]' && "$n5" == '[{"code":"C00000b","first_visit":false}]' ]] || fail "rpc ensure_invite_code: $o5 / $n5"
o6=$(req -H 'Content-Profile: miniapp_traffic' -X POST "$u/rpc/increment_click" -d '{"p_id":1}' -o /dev/null -w '%{http_code}')
n6=$(req -H 'Accept-Profile: traffic' "$u/botlinks?select=clicks&id=eq.1")
[[ "$o6" == 204 && "$n6" == '[{"clicks":2}]' ]] || fail "void rpc via old profile: $o6 / $n6"
o7=$(req -H 'Content-Profile: miniapp_features' -X POST "$u/rpc/create_character_comment" -d '{"p_character_id":"00000000-0000-0000-0000-0000000000c2","p_body":"yo"}')
[[ "$o7" == *'"body":"yo"'* ]] || fail "setof rpc via old profile: $o7"
echo "PostgREST: GET / upsert / insert / patch / table, void and setof RPC agree across profiles"

echo "== database without pg_cron (TEST)"
app_psql nocron_db -f - <"$migration" >"$out_dir/nocron.migrate.log" 2>&1 || { cat "$out_dir/nocron.migrate.log"; fail 'migration failed without pg_cron'; }
grep -q 'p7a-naming: renamed 3 schemas and 6 relations, rewrote 9 functions; compat layer has 16 views and 8 forwarders' "$out_dir/nocron.migrate.log" ||
  { cat "$out_dir/nocron.migrate.log"; fail 'unexpected summary NOTICE without pg_cron'; }
[[ "$(app_psql nocron_db -At -c "SELECT count(*) FROM pg_namespace WHERE nspname IN ('analytics','features','traffic','cron')")" == 3 ]] ||
  fail 'nocron_db should have the three new schemas and still no cron'

echo "== rerun is a no-op"
app_psql new_db -f - <"$migration" 2>&1 | grep -q 'p7a-naming: already renamed; nothing to do' || fail 'rerun should skip'

echo "== refuse when a new name is taken"
app_psql drift_db -c 'CREATE SCHEMA features' >/dev/null
if app_psql drift_db -f - <"$migration" >"$out_dir/drift.log" 2>&1; then fail 'drift_db should refuse'; fi
grep -q 'schema features already exists' "$out_dir/drift.log" || { cat "$out_dir/drift.log"; fail 'wrong refusal'; }
[[ "$(app_psql drift_db -At -c "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'miniapp\_%'")" == 3 ]] || fail 'refusal should leave old schemas'

echo "== contract: refuse while something outside the compat layer still uses old names"
# 库外视图依赖兼容视图：不带 CASCADE 的 DROP VIEW 失败，整体回滚
app_psql compat_db -c 'CREATE VIEW public.p7a_probe AS SELECT * FROM miniapp_features.user_lobby_recommendations' >/dev/null
if app_psql compat_db -f - <"$contract" >"$out_dir/contract-dep.log" 2>&1; then fail 'contract should refuse with a dependent view'; fi
grep -q 'depend' "$out_dir/contract-dep.log" || { cat "$out_dir/contract-dep.log"; fail 'wrong refusal for dependent view'; }
[[ "$(app_psql compat_db -At -c "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'miniapp\_%'")" == 3 ]] || fail 'refusal should keep the compat layer'
app_psql compat_db -c 'DROP VIEW public.p7a_probe' >/dev/null
# 函数体不进依赖表：兼容层外的函数还提旧名字就拒绝
app_psql compat_db -c "CREATE FUNCTION public.p7a_probe() RETURNS bigint LANGUAGE plpgsql AS \$\$ BEGIN RETURN (SELECT count(*) FROM miniapp_features.user_marks); END \$\$" >/dev/null
if app_psql compat_db -f - <"$contract" >"$out_dir/contract-fn.log" 2>&1; then fail 'contract should refuse with an old-name function'; fi
grep -q 'functions outside the compat layer still name old objects: p7a_probe()' "$out_dir/contract-fn.log" ||
  { cat "$out_dir/contract-fn.log"; fail 'wrong refusal for old-name function'; }
app_psql compat_db -c 'DROP FUNCTION public.p7a_probe()' >/dev/null

echo "== contract (as non-superuser app_admin)"
for db in new_db compat_db nocron_db; do
  app_psql "$db" -f - <"$contract" >"$out_dir/$db.contract.log" 2>&1 || { cat "$out_dir/$db.contract.log"; fail "contract failed on $db"; }
  grep -q 'p7a-naming-contract: dropped 8 forwarders, 16 compat views and 3 schemas' "$out_dir/$db.contract.log" ||
    { cat "$out_dir/$db.contract.log"; fail "unexpected contract NOTICE on $db"; }
  [[ "$(app_psql "$db" -At -c "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'miniapp\_%'")" == 0 ]] || fail "old schemas left on $db"
done
grep -q 'authenticator pgrst.db_schemas was' "$out_dir/new_db.contract.log" || fail 'expected old db_schemas NOTICE on contract'
cfg=$(su_psql postgres -At -c "SELECT string_agg(c, ' | ' ORDER BY c) FROM pg_roles r, unnest(r.rolconfig) c WHERE r.rolname = 'authenticator' AND c LIKE 'pgrst.%'")
[[ "$cfg" == 'pgrst.db_extra_search_path=public, graphql_public, traffic | pgrst.db_schemas=graphql_public, analytics, traffic, admin, app_core, features, experience, billing, drama_archive, media_plaza' ]] ||
  fail "unexpected PostgREST config after contract: $cfg"
# 新名字照常读写（大厅推荐 upsert + 曝光 ON CONFLICT，走后端同款 SQL）
app_psql new_db -At >/dev/null <<'SQL' || fail 'new names should still work after contract'
SELECT count(*) FROM features.lobby_recommendations;
SELECT count(*) FROM analytics.core_daily;
SELECT count(*) FROM traffic.invite_codes;
SQL
app_psql new_db -f - <"$contract" 2>&1 | grep -q 'p7a-naming-contract: compat layer already removed; nothing to do' || fail 'contract rerun should skip'

echo "ALL P7A NAMING CHECKS PASSED"
