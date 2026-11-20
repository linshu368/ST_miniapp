#!/usr/bin/env bash
# Disposable PG17 only. Verifies 20261119_instruction_placeholders_optional.sql：
# 主体模板不再必须带 {{STATUS_RULES}} / {{MEMORY_RULES}}，其他占位照旧必填，重跑不报错。
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="st-placeholders-${RANDOM}-$$"
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
-- 替身：只保留线上定义里模板必填占位这一段原文（2026-11-19 只读核对）
CREATE FUNCTION admin.validate_managed_config_value(p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_field text;
BEGIN
  IF p_config_key = 'system_instructions' THEN
    FOREACH v_field IN ARRAY ARRAY[
        '{{CHOICE_RULES}}', '{{STATUS_RULES}}', '{{MEMORY_RULES}}',
        '{{WORD_COUNT}}', '{{USER_CUSTOM_INSTRUCTIONS}}'
    ] LOOP
      IF position(v_field IN coalesce(p_text_value, '')) = 0 THEN
        RAISE EXCEPTION 'system_instructions is missing required placeholder %', v_field;
      END IF;
    END LOOP;
  END IF;
END $$;
SQL
"${task_psql[@]}" < "$task_root/packages/shared/migrations/20261119_instruction_placeholders_optional.sql" >/dev/null
"${task_psql[@]}" <<'SQL'
DO $t$
BEGIN
  PERFORM admin.validate_managed_config_value('system_instructions', NULL, '{{CHOICE_RULES}}{{WORD_COUNT}}{{USER_CUSTOM_INSTRUCTIONS}}');
  BEGIN
    PERFORM admin.validate_managed_config_value('system_instructions', NULL, '{{CHOICE_RULES}}{{USER_CUSTOM_INSTRUCTIONS}}');
    RAISE EXCEPTION 'word count must stay required';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%{{WORD_COUNT}}%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'behaviour ok';
END
$t$;
SQL
"${task_psql[@]}" < "$task_root/packages/shared/migrations/20261119_instruction_placeholders_optional.sql" >/dev/null
echo "instruction placeholders optional migration: all checks passed"
