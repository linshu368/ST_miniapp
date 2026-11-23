#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
#
# 20261123_db_reorg_drop_prompt_observations.sql 的本地验证（迁移用非超级用户 app_admin 执行）：
#   - 开轮函数用生产原文（fixtures/drop_prompt_observations_begin_original.sql，md5 与生产 pg_get_functiondef 相同）；
#   - 改写后的函数与原文的差异恰好是去掉写快照的 5 行，其余逐字不变；所有者、权限、注释不变；
#   - 清理任务被删、其他定时任务不动；清理函数与表被删；
#   - 没装 pg_cron 的库（TEST）照常执行；重跑跳过；锚点对不上 / 还有别的函数用这张表时拒绝且不改任何东西。
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
migration="$repo_root/packages/shared/migrations/20261123_db_reorg_drop_prompt_observations.sql"
original="$repo_root/packages/shared/migrations/fixtures/drop_prompt_observations_begin_original.sql"
pg="drop-prompt-pg-$$"
out_dir=$(mktemp -d)
trap 'docker rm -f "$pg" >/dev/null 2>&1 || true; rm -rf "$out_dir"' EXIT

[[ "$(md5 -q "$original" 2>/dev/null || md5sum "$original" | cut -d' ' -f1)" == 7b94cf8345eb8fd5060eceff13ab7aa9 ]] ||
  { echo 'FAIL: fixture is not the production original' >&2; exit 1; }

docker run --rm -d --network none --name "$pg" -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do docker exec "$pg" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2
su_psql() { local db=$1; shift; docker exec -i "$pg" psql -X -q -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
app_psql() { local db=$1; shift; docker exec -i "$pg" psql -X -q -U app_admin -d "$db" -v ON_ERROR_STOP=1 "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

su_psql postgres >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN CREATEROLE;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
SQL

# 只建函数依赖的最小骨架：函数正文按生产原文创建，表结构只需能解析 %ROWTYPE。
fixture() {
  local db=$1 with_cron=$2
  su_psql postgres -c "CREATE DATABASE $db OWNER app_admin" >/dev/null
  if [[ "$with_cron" == cron ]]; then
    su_psql "$db" >/dev/null <<'SQL'
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text, schedule text NOT NULL, command text NOT NULL,
  username text NOT NULL DEFAULT current_user, active boolean NOT NULL DEFAULT true);
CREATE FUNCTION cron.unschedule(job_id bigint) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS
  $$ DELETE FROM cron.job WHERE jobid = job_id RETURNING true $$;
GRANT USAGE ON SCHEMA cron TO app_admin;
GRANT SELECT ON cron.job TO app_admin;
GRANT EXECUTE ON FUNCTION cron.unschedule(bigint) TO app_admin;
INSERT INTO cron.job(jobname, schedule, command) VALUES
  ('chat_prompt_observations_retention', '17 * * * *', E'SET statement_timeout = ''60s''; SET lock_timeout = ''1s''; SELECT ops.cleanup_chat_prompt_observations(interval ''7 days'', 1000, 20);'),
  ('core_daily_recent_30m', '7,37 * * * *', 'SELECT 1');
SQL
  fi
  app_psql "$db" >/dev/null <<'SQL'
CREATE SCHEMA experience; CREATE SCHEMA ops;
CREATE TABLE experience.chat_history (id uuid PRIMARY KEY, status text, llm_finish_reason text, llm_charge_id uuid,
  llm_billing_snapshot jsonb, session_id uuid, turn_index int, revision int);
CREATE TABLE ops.chat_prompt_observations (history_id uuid NOT NULL, messages_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT chat_prompt_observations_pkey PRIMARY KEY (history_id));
CREATE FUNCTION ops.cleanup_chat_prompt_observations(p_keep interval DEFAULT interval '7 days', p_batch integer DEFAULT 1000,
  p_max_batches integer DEFAULT 20) RETURNS bigint LANGUAGE plpgsql AS
  $$ BEGIN DELETE FROM ops.chat_prompt_observations WHERE created_at < now() - p_keep; RETURN 0; END $$;
SQL
  app_psql "$db" -f - <"$original" >/dev/null
  app_psql "$db" >/dev/null <<'SQL'
REVOKE ALL ON FUNCTION experience.begin_chat_generation_observation(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION experience.begin_chat_generation_observation(uuid, jsonb) TO service_role;
COMMENT ON FUNCTION experience.begin_chat_generation_observation(uuid, jsonb) IS 'admission RPC';
SQL
  [[ "$(app_psql "$db" -At -c "SELECT md5(pg_get_functiondef('experience.begin_chat_generation_observation(uuid,jsonb)'::regprocedure))")" == 7b94cf8345eb8fd5060eceff13ab7aa9 ]] ||
    fail "$db: fixture function differs from production after create"
}

fixture prod_db cron
fixture test_db nocron
fixture drift_db cron
fixture other_db cron

state() { # db -> owner|acl|comment|jobs|objects
  app_psql "$1" -At <<'SQL'
SELECT pg_get_userbyid(p.proowner) || '|' || array_to_string(p.proacl, ',') || '|' ||
  obj_description(p.oid, 'pg_proc') || '|' ||
  coalesce((SELECT string_agg(jobname, ',' ORDER BY jobname) FROM cron.job), '-') || '|' ||
  (to_regclass('ops.chat_prompt_observations') IS NOT NULL)::text || ',' ||
  (to_regprocedure('ops.cleanup_chat_prompt_observations(interval,integer,integer)') IS NOT NULL)::text
FROM pg_proc p WHERE p.oid = 'experience.begin_chat_generation_observation(uuid,jsonb)'::regprocedure;
SQL
}
state_nocron() {
  app_psql "$1" -At <<'SQL'
SELECT pg_get_userbyid(p.proowner) || '|' || array_to_string(p.proacl, ',') || '|' ||
  obj_description(p.oid, 'pg_proc') || '|' ||
  (to_regclass('ops.chat_prompt_observations') IS NOT NULL)::text || ',' ||
  (to_regprocedure('ops.cleanup_chat_prompt_observations(interval,integer,integer)') IS NOT NULL)::text
FROM pg_proc p WHERE p.oid = 'experience.begin_chat_generation_observation(uuid,jsonb)'::regprocedure;
SQL
}

before=$(state prod_db)
echo "== migrate (pg_cron present, as production)"
app_psql prod_db -f - <"$migration" >"$out_dir/prod.log" 2>&1 || { cat "$out_dir/prod.log"; fail 'migration failed'; }
grep -q 'drop-prompt-observations: rewrote experience.begin_chat_generation_observation(uuid,jsonb), unscheduled 1 cron job(s), dropped cleanup function and table' "$out_dir/prod.log" ||
  { cat "$out_dir/prod.log"; fail 'unexpected NOTICE'; }
after=$(state prod_db)
[[ "$before" == "app_admin|app_admin=X/app_admin,service_role=X/app_admin|admission RPC|chat_prompt_observations_retention,core_daily_recent_30m|true,true" ]] ||
  fail "unexpected state before: $before"
[[ "$after" == "app_admin|app_admin=X/app_admin,service_role=X/app_admin|admission RPC|core_daily_recent_30m|false,false" ]] ||
  fail "unexpected state after: $after"

# 差异恰好是去掉写快照的 5 行
# psql 在输出末尾多打一个换行，去掉后与原文逐字比较
app_psql prod_db -At -c "SELECT pg_get_functiondef('experience.begin_chat_generation_observation(uuid,jsonb)'::regprocedure)" |
  sed '${/^$/d;}' >"$out_dir/new.sql"
diff "$original" "$out_dir/new.sql" >"$out_dir/fn.diff" || true
[[ "$(grep -c '^<' "$out_dir/fn.diff")" == 5 && "$(grep -c '^>' "$out_dir/fn.diff")" == 0 ]] ||
  { cat "$out_dir/fn.diff"; fail 'function diff should be exactly the 5 removed snapshot lines'; }
grep -q 'chat_prompt_observations' "$out_dir/new.sql" && fail 'rewritten function still names the table'
grep -q 'chat_history_display_metadata' "$out_dir/new.sql" || fail 'display metadata write must stay'
echo "function: only the 5 snapshot lines removed; owner, grants, comment and the other cron job unchanged"

echo "== rerun is a no-op"
app_psql prod_db -f - <"$migration" 2>&1 | grep -q 'drop-prompt-observations: already dropped; nothing to do' || fail 'rerun should skip'

echo "== database without pg_cron (TEST)"
app_psql test_db -f - <"$migration" >"$out_dir/test.log" 2>&1 || { cat "$out_dir/test.log"; fail 'migration failed without pg_cron'; }
grep -q 'unscheduled 0 cron job(s)' "$out_dir/test.log" || { cat "$out_dir/test.log"; fail 'unexpected NOTICE without pg_cron'; }
[[ "$(state_nocron test_db)" == "app_admin|app_admin=X/app_admin,service_role=X/app_admin|admission RPC|false,false" ]] ||
  fail "unexpected state without pg_cron: $(state_nocron test_db)"

echo "== refuse when the anchor drifted"
drift_before=$(state drift_db)
app_psql drift_db -At -c "SELECT pg_get_functiondef('experience.begin_chat_generation_observation(uuid,jsonb)'::regprocedure)" |
  sed 's/never product state\./never product state!/' | app_psql drift_db -f - >/dev/null
if app_psql drift_db -f - <"$migration" >"$out_dir/drift.log" 2>&1; then fail 'drifted anchor should refuse'; fi
grep -q 'expected the snapshot block exactly once' "$out_dir/drift.log" || { cat "$out_dir/drift.log"; fail 'wrong refusal for drift'; }
[[ "$(state drift_db)" == "$drift_before" ]] || fail 'refusal must not change anything'

echo "== refuse when another function still uses the table"
other_before=$(state other_db)
app_psql other_db -c "CREATE FUNCTION ops.p_probe() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM ops.chat_prompt_observations'" >/dev/null
if app_psql other_db -f - <"$migration" >"$out_dir/other.log" 2>&1; then fail 'other user of the table should refuse'; fi
grep -q 'other functions still use the table: ops.p_probe()' "$out_dir/other.log" || { cat "$out_dir/other.log"; fail 'wrong refusal for other user'; }
[[ "$(state other_db)" == "$other_before" ]] || fail 'refusal must not change anything'

echo "ALL DROP-PROMPT-OBSERVATIONS CHECKS PASSED"
