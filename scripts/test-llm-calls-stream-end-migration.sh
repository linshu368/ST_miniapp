#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261124_llm_calls_stream_end.sql: 新列与约束生效、旧行不受影响、新 role rewrite 可写、
# 非法值被拒、重跑不变、文件头的回滚语句可执行。
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="st-llm-calls-stream-end-${RANDOM}-$$"
cleanup() { docker rm -f "$task_container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 30); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
task_psql=(docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1)

# 生产 ops.llm_calls 中与本迁移相关的部分（列与 role 约束原文同 20261119_db_reorg_p6a2c3_call_ledger_expand.sql）
"${task_psql[@]}" >/dev/null <<'SQL'
CREATE SCHEMA ops;
CREATE TABLE ops.llm_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_history_id uuid,
  provider text,
  model text,
  role text,
  end_reason text,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE ops.llm_calls
  ADD CONSTRAINT llm_calls_role_check CHECK (role IS NULL OR role IN ('primary', 'fallback'));
INSERT INTO ops.llm_calls(role, end_reason) VALUES ('primary', 'first_token_observed'), ('fallback', 'cancelled'), (NULL, NULL);
SQL

migration="$task_root/packages/shared/migrations/20261124_llm_calls_stream_end.sql"
"${task_psql[@]}" < "$migration" >/dev/null
"${task_psql[@]}" < "$migration" >/dev/null # 重跑

"${task_psql[@]}" <<'SQL'
DO $t$
BEGIN
  IF (SELECT count(*) FROM ops.llm_calls WHERE stream_end IS NULL) <> 3 THEN
    RAISE EXCEPTION 'existing rows changed';
  END IF;
    INSERT INTO ops.llm_calls(role, end_reason, stream_end) VALUES ('rewrite', 'refused', 'refused');
  UPDATE ops.llm_calls SET stream_end = 'stalled' WHERE end_reason = 'first_token_observed';
  BEGIN
    INSERT INTO ops.llm_calls(role) VALUES ('continuation');
    RAISE EXCEPTION 'invalid role accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO ops.llm_calls(stream_end) VALUES ('weird');
    RAISE EXCEPTION 'invalid stream_end accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'ops.llm_calls'::regclass
        AND conname IN ('llm_calls_role_check', 'llm_calls_stream_end_check') AND convalidated) <> 2 THEN
    RAISE EXCEPTION 'constraints not validated';
  END IF;
END
$t$;

-- 文件头的回滚步骤
ALTER TABLE ops.llm_calls DROP CONSTRAINT llm_calls_stream_end_check, DROP COLUMN stream_end;
UPDATE ops.llm_calls SET role = 'fallback' WHERE role = 'rewrite';
ALTER TABLE ops.llm_calls DROP CONSTRAINT llm_calls_role_check,
  ADD CONSTRAINT llm_calls_role_check CHECK (role IS NULL OR role IN ('primary', 'fallback'));
SQL
echo "OK: 20261124_llm_calls_stream_end.sql"
