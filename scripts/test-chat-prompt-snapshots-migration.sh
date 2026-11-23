#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
#
# 20261123_chat_prompt_snapshots.sql 的本地验证（迁移用非超级用户 app_admin 执行）：
#   - 有 pg_cron（生产）/ 没有（TEST）两种库都能执行，重跑不变；定时任务只建一个、每天 20:17 UTC、保留 7 天；
#   - service_role 只能经 RPC 写，不能直接读写表；anon / authenticated 不能调 RPC；
#   - RPC 写入、同一轮覆盖、拒绝非数组 / 空数组；
#   - 清理函数只删 7 天前的快照，拒绝少于 1 天的保留期。
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
migration="$repo_root/packages/shared/migrations/20261123_chat_prompt_snapshots.sql"
pg="prompt-snap-pg-$$"
out_dir=$(mktemp -d)
trap 'docker rm -f "$pg" >/dev/null 2>&1 || true; rm -rf "$out_dir"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

docker run --rm -d --network none --name "$pg" -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do docker exec "$pg" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2
su_psql() { local db=$1; shift; docker exec -i "$pg" psql -X -q -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
app_psql() { local db=$1; shift; docker exec -i "$pg" psql -X -q -U app_admin -d "$db" -v ON_ERROR_STOP=1 "$@"; }

su_psql postgres >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN CREATEROLE;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
GRANT service_role, anon TO app_admin;
SQL

fixture() {
  local db=$1 with_cron=$2
  su_psql postgres -c "CREATE DATABASE $db OWNER app_admin" >/dev/null
  if [[ "$with_cron" == cron ]]; then
    su_psql "$db" >/dev/null <<'SQL'
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text, schedule text NOT NULL, command text NOT NULL,
  username text NOT NULL DEFAULT current_user, active boolean NOT NULL DEFAULT true);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE sql SECURITY DEFINER AS
  $$ INSERT INTO cron.job(jobname, schedule, command) VALUES (job_name, schedule, command) RETURNING jobid $$;
GRANT USAGE ON SCHEMA cron TO app_admin;
GRANT SELECT ON cron.job TO app_admin;
GRANT EXECUTE ON FUNCTION cron.schedule(text, text, text) TO app_admin;
SQL
  fi
  app_psql "$db" >/dev/null <<'SQL'
CREATE SCHEMA experience; CREATE SCHEMA ops;
GRANT USAGE ON SCHEMA experience, ops TO service_role, anon;
SQL
}

fixture prod_db cron
fixture test_db nocron

echo "== migrate (pg_cron present, as production) and rerun"
app_psql prod_db -f - <"$migration" >"$out_dir/prod.log" 2>&1 || { cat "$out_dir/prod.log"; fail 'migration failed'; }
app_psql prod_db -f - <"$migration" >"$out_dir/prod2.log" 2>&1 || { cat "$out_dir/prod2.log"; fail 'rerun failed'; }
[[ "$(app_psql prod_db -At -c "SELECT count(*) || '|' || min(schedule) || '|' || (min(command) LIKE '%cleanup_chat_prompt_snapshots(interval ''7 days'', 1000, 20)%') FROM cron.job WHERE jobname = 'chat_prompt_snapshots_retention'")" == "1|17 20 * * *|true" ]] ||
  fail 'expected exactly one daily retention job keeping 7 days'

echo "== database without pg_cron (TEST)"
app_psql test_db -f - <"$migration" >"$out_dir/test.log" 2>&1 || { cat "$out_dir/test.log"; fail 'migration failed without pg_cron'; }
[[ "$(app_psql test_db -At -c "SELECT to_regclass('ops.chat_prompt_snapshots') IS NOT NULL AND to_regprocedure('ops.cleanup_chat_prompt_snapshots(interval,integer,integer)') IS NOT NULL")" == t ]] ||
  fail 'TEST should get the table and the cleanup function'

echo "== privileges"
priv=$(app_psql prod_db -At -c "SELECT
  has_table_privilege('service_role', 'ops.chat_prompt_snapshots', 'SELECT')::int::text ||
  has_table_privilege('service_role', 'ops.chat_prompt_snapshots', 'INSERT')::int::text ||
  has_function_privilege('service_role', 'experience.record_chat_prompt_snapshot(uuid,jsonb)', 'EXECUTE')::int::text ||
  has_function_privilege('anon', 'experience.record_chat_prompt_snapshot(uuid,jsonb)', 'EXECUTE')::int::text ||
  has_function_privilege('authenticated', 'experience.record_chat_prompt_snapshot(uuid,jsonb)', 'EXECUTE')::int::text ||
  has_function_privilege('service_role', 'ops.cleanup_chat_prompt_snapshots(interval,integer,integer)', 'EXECUTE')::int::text")
[[ "$priv" == "001000" ]] || fail "unexpected privileges $priv (service_role select/insert, rpc service/anon/auth, cleanup)"

echo "== RPC writes as service_role"
app_psql prod_db >/dev/null <<'SQL'
SET ROLE service_role;
SELECT experience.record_chat_prompt_snapshot('00000000-0000-4000-8000-000000000001',
  '[{"role":"system","content":"s"},{"role":"user","content":"第一版"}]');
SELECT experience.record_chat_prompt_snapshot('00000000-0000-4000-8000-000000000001',
  '[{"role":"system","content":"s"},{"role":"user","content":"重放后"}]');
SELECT experience.record_chat_prompt_snapshot('00000000-0000-4000-8000-000000000002', '[{"role":"user","content":"x"}]');
RESET ROLE;
SQL
[[ "$(app_psql prod_db -At -c "SELECT count(*) || '|' || (SELECT messages_snapshot->1->>'content' FROM ops.chat_prompt_snapshots WHERE history_id = '00000000-0000-4000-8000-000000000001') FROM ops.chat_prompt_snapshots")" == "2|重放后" ]] ||
  fail 'replay should overwrite the same turn'
for bad in "'{}'" "'[]'" "'\"text\"'"; do
  if app_psql prod_db -c "SET ROLE service_role; SELECT experience.record_chat_prompt_snapshot('00000000-0000-4000-8000-000000000003', $bad)" >/dev/null 2>&1; then
    fail "RPC should reject $bad"
  fi
done
if app_psql prod_db -c "SET ROLE service_role; SELECT count(*) FROM ops.chat_prompt_snapshots" >/dev/null 2>&1; then
  fail 'service_role must not read the table directly'
fi
if app_psql prod_db -c "SET ROLE anon; SELECT experience.record_chat_prompt_snapshot('00000000-0000-4000-8000-000000000004', '[{\"role\":\"user\",\"content\":\"x\"}]')" >/dev/null 2>&1; then
  fail 'anon must not call the RPC'
fi

echo "== retention"
app_psql prod_db >/dev/null <<'SQL'
INSERT INTO ops.chat_prompt_snapshots (history_id, messages_snapshot, created_at)
SELECT gen_random_uuid(), '[{"role":"user","content":"old"}]', now() - interval '8 days' - g * interval '1 minute'
FROM generate_series(1, 2500) g;
INSERT INTO ops.chat_prompt_snapshots (history_id, messages_snapshot, created_at)
VALUES ('00000000-0000-4000-8000-000000000005', '[{"role":"user","content":"6 days"}]', now() - interval '6 days');
SQL
[[ "$(app_psql prod_db -At -c "SELECT ops.cleanup_chat_prompt_snapshots(interval '7 days', 1000, 20)")" == 2500 ]] || fail 'cleanup should delete the 2500 old rows'
[[ "$(app_psql prod_db -At -c "SELECT count(*) FROM ops.chat_prompt_snapshots")" == 3 ]] || fail 'rows within 7 days must stay'
if app_psql prod_db -c "SELECT ops.cleanup_chat_prompt_snapshots(interval '1 hour')" >/dev/null 2>&1; then
  fail 'retention shorter than 1 day should be rejected'
fi

echo "ALL CHAT-PROMPT-SNAPSHOTS CHECKS PASSED"
