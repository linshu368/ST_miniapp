#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261124_chat_recovery_config.sql: 登记 key、在 status_memory_model_config 分支前插入校验分支、
# 合法值通过、各种不合法值以 22023 拒绝（迁移自带核对）、重跑跳过、锚点不唯一时拒绝改写。
# 校验函数用最小替身：与生产同样的分发结构与锚点缩进（生产锚点 2026-11-24 实测恰好一处）。
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="st-chat-recovery-config-${RANDOM}-$$"
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
CREATE SCHEMA admin;
CREATE TABLE admin.managed_config_keys (
  config_key text PRIMARY KEY, managed_via text NOT NULL, retired_at timestamptz, note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO admin.managed_config_keys(config_key, managed_via) VALUES ('status_memory_model_config', 'operations_config');
CREATE FUNCTION admin.is_managed_config_key(p_key text) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT EXISTS (SELECT 1 FROM admin.managed_config_keys WHERE config_key = p_key AND retired_at IS NULL) $$;
CREATE FUNCTION admin.validate_managed_config_value(p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL::text)
 RETURNS void LANGUAGE plpgsql STABLE SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF admin.is_managed_config_key(p_config_key) IS NOT TRUE THEN
    RAISE EXCEPTION 'config key is not managed by admin: %', p_config_key USING ERRCODE = '22023';
  END IF;
  CASE p_config_key
    WHEN 'status_memory_model_config' THEN
      IF p_value IS NULL THEN
        RAISE EXCEPTION 'status memory model config requires a value' USING ERRCODE = '22023';
      END IF;
    ELSE
      RAISE EXCEPTION 'managed config validation is missing for key: %', p_config_key
        USING ERRCODE = '22023';
  END CASE;
END;
$function$;
SQL

migration="$task_root/packages/shared/migrations/20261124_chat_recovery_config.sql"
"${task_psql[@]}" < "$migration" >/dev/null
"${task_psql[@]}" < "$migration" >/dev/null # 重跑：已加过的分支跳过

"${task_psql[@]}" <<'SQL'
DO $t$
DECLARE
  v_def text := pg_get_functiondef('admin.validate_managed_config_value(text,jsonb,text)'::regprocedure);
BEGIN
  IF (SELECT count(*) FROM admin.managed_config_keys WHERE config_key = 'chat_recovery_config') <> 1 THEN
    RAISE EXCEPTION 'key not registered';
  END IF;
  IF (length(v_def) - length(replace(v_def, 'WHEN ''chat_recovery_config'' THEN', ''))) / length('WHEN ''chat_recovery_config'' THEN') <> 1 THEN
    RAISE EXCEPTION 'branch not inserted exactly once';
  END IF;
  -- 原有分支仍生效
  PERFORM admin.validate_managed_config_value('status_memory_model_config', '{}'::jsonb, NULL);
  -- 运营平台初始值与带词池的值都能通过
  PERFORM admin.validate_managed_config_value('chat_recovery_config',
    '{"fallback_first_token_ms": 3000, "interruption": {"enabled": true, "stall_ms": 3000}, "refusal": {"enabled": false, "check_chars": 30, "keywords": ["我不能写", "I cannot"]}}', NULL);
END
$t$;
SQL

# 锚点不唯一时拒绝改写：在新库里放两个锚点
"${task_psql[@]}" >/dev/null <<'SQL'
DELETE FROM admin.managed_config_keys WHERE config_key = 'chat_recovery_config';
CREATE OR REPLACE FUNCTION admin.validate_managed_config_value(p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL::text)
 RETURNS void LANGUAGE plpgsql STABLE AS
$function$
BEGIN
  CASE p_config_key
    WHEN 'status_memory_model_config' THEN NULL;
    WHEN 'status_memory_model_config' THEN NULL;
    ELSE NULL;
  END CASE;
END;
$function$;
SQL
if "${task_psql[@]}" < "$migration" >/dev/null 2>&1; then
  echo "FAIL: ambiguous anchor accepted"; exit 1
fi
echo "OK: 20261124_chat_recovery_config.sql"
