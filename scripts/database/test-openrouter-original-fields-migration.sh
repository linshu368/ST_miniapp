#!/usr/bin/env bash
# Isolated local PostgreSQL only: no Railway/Supabase credentials or business rows.
set -euo pipefail

task_root="$(cd "$(dirname "$0")/../.." && pwd)"
task_pg_bin="${OPENROUTER_TEST_PG_BIN:-$(pg_config --bindir)}"
task_dir="$(mktemp -d /tmp/openrouter-fields.XXXXXX)"

cleanup() {
  "$task_pg_bin/pg_ctl" -D "$task_dir/data" -m fast -w stop >/dev/null 2>&1 || true
  case "$task_dir" in /tmp/openrouter-fields.*) rm -rf -- "$task_dir" ;; esac
}
trap cleanup EXIT

"$task_pg_bin/initdb" -D "$task_dir/data" -U postgres --auth=trust --encoding=UTF8 --locale=C >"$task_dir/init.log"
"$task_pg_bin/pg_ctl" -D "$task_dir/data" -l "$task_dir/server.log" \
  -o "-k $task_dir -p 55432 -c listen_addresses=''" -w start >/dev/null

task_psql=("$task_pg_bin/psql" -X -h "$task_dir" -p 55432 -U postgres -d postgres -v ON_ERROR_STOP=1)
task_migrations="$task_root/packages/shared/migrations"
task_migration="$task_migrations/20261016_openrouter_original_metadata_fields.sql"

"${task_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA experience;
CREATE TABLE experience.chat_history (
  id uuid PRIMARY KEY, llm_provider_name text, llm_finish_reason text,
  llm_usage jsonb, llm_usage_cache jsonb,
  llm_native_tokens_cached integer, llm_native_tokens_reasoning integer,
  llm_native_tokens_completion integer, llm_native_tokens_prompt integer,
  llm_latency numeric, llm_generation_time numeric, llm_model text,
  llm_generation_id text, llm_billing_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE experience.venice_chat_history (
  chat_history_id uuid UNIQUE REFERENCES experience.chat_history(id)
);
INSERT INTO experience.chat_history (
  id,llm_provider_name,llm_finish_reason,llm_usage,llm_usage_cache,
  llm_native_tokens_cached,llm_native_tokens_reasoning,llm_native_tokens_completion,
  llm_native_tokens_prompt,llm_latency,llm_generation_time,llm_model,llm_generation_id,llm_billing_snapshot
) VALUES (
  '00000000-0000-0000-0000-000000000001','Google','cancelled','0.01','0',
  0,0,20,100,0,200,'vendor/model','gen-fixture','{"provider":"openrouter"}'
), (
  '00000000-0000-0000-0000-000000000002',NULL,NULL,NULL,NULL,
  NULL,NULL,NULL,NULL,NULL,NULL,NULL,'gen-placeholder',NULL
);
CREATE TABLE experience.parent_before AS SELECT * FROM experience.chat_history;
SQL

for task_file in \
  20261015_openrouter_chat_history.sql \
  20261015_openrouter_chat_history_backfill.sql \
  20261015_openrouter_chat_history_venice_exclusion_backfill.sql; do
  "${task_psql[@]}" -f "$task_migrations/$task_file" >/dev/null
done

"${task_psql[@]}" >/dev/null <<'SQL'
-- Simulate live upstream metadata; parent business finish_reason must stay cancelled.
UPDATE experience.openrouter_chat_history
SET llm_finish_reason='stop', llm_generation_data='{"usage_cache":0}'
WHERE llm_generation_id='gen-fixture';
SQL

"${task_psql[@]}" -f "$task_migration" >/dev/null
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM experience.openrouter_chat_history
    WHERE ROW(provider_name,finish_reason,usage,usage_cache,native_tokens_cached,
      native_tokens_reasoning,native_tokens_completion,native_tokens_prompt,latency,generation_time,model)
    IS DISTINCT FROM ROW(llm_provider_name,llm_finish_reason,llm_usage,llm_usage_cache,llm_native_tokens_cached,
      llm_native_tokens_reasoning,llm_native_tokens_completion,llm_native_tokens_prompt,llm_latency,llm_generation_time,llm_model)
  ) THEN RAISE EXCEPTION 'field values differ after expansion'; END IF;
  IF (SELECT count(*) FROM experience.openrouter_chat_history) <> 2
    THEN RAISE EXCEPTION 'backfill changed row count'; END IF;
  IF EXISTS (SELECT * FROM experience.chat_history EXCEPT SELECT * FROM experience.parent_before)
    THEN RAISE EXCEPTION 'parent was changed'; END IF;
  IF has_table_privilege('anon','experience.openrouter_chat_history','SELECT')
    OR has_table_privilege('authenticated','experience.openrouter_chat_history','SELECT')
    OR NOT has_table_privilege('service_role','experience.openrouter_chat_history','SELECT,INSERT,UPDATE')
    THEN RAISE EXCEPTION 'grants changed'; END IF;
  BEGIN
    UPDATE experience.openrouter_chat_history SET usage='"invalid"';
    RAISE EXCEPTION 'invalid usage accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE experience.openrouter_chat_history SET native_tokens_prompt=-1;
    RAISE EXCEPTION 'negative tokens accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
-- A new writer's canonical values must survive a reviewed migration replay.
UPDATE experience.openrouter_chat_history
SET usage='0',provider_name='NewVendor' WHERE llm_generation_id='gen-fixture';
SQL

"${task_psql[@]}" -f "$task_migration" >"$task_dir/replay.log" 2>&1
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM experience.openrouter_chat_history
    WHERE llm_generation_id='gen-fixture' AND usage='0' AND usage_cache='0'
      AND provider_name='NewVendor' AND finish_reason='stop'
      AND llm_generation_data='{"usage_cache":0}')
    THEN RAISE EXCEPTION 'replay overwrote canonical values or retained fields'; END IF;
  IF NOT EXISTS (SELECT 1 FROM experience.openrouter_chat_history
    WHERE llm_generation_id='gen-placeholder' AND usage IS NULL AND usage_cache IS NULL)
    THEN RAISE EXCEPTION 'NULL placeholder was lost'; END IF;
END $$;
DELETE FROM experience.chat_history WHERE id='00000000-0000-0000-0000-000000000002';
DO $$ BEGIN
  IF (SELECT count(*) FROM experience.openrouter_chat_history) <> 1
    THEN RAISE EXCEPTION 'cascade changed'; END IF;
END $$;
ALTER TABLE experience.openrouter_chat_history DROP CONSTRAINT openrouter_chat_history_original_fields_check;
ALTER TABLE experience.openrouter_chat_history ALTER COLUMN latency TYPE text;
SQL

if "${task_psql[@]}" -f "$task_migration" >"$task_dir/shape.log" 2>&1; then
  printf 'FAIL: incompatible canonical shape was accepted\n' >&2
  exit 1
fi
rg -q 'Unexpected OpenRouter metadata column shape' "$task_dir/shape.log"
printf 'OpenRouter migration passed: 11 field values, zeros/NULL, parent isolation, grants, constraints, replay, FK cascade and shape guard.\n'
