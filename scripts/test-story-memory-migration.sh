#!/usr/bin/env bash
# Story memory migration on disposable PG17 (replays the branch/override baseline first).
# Disposable PG17 only. No remote URI, host ports, user data, model or billing calls.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="st-story-memory-${RANDOM}-$$"
task_temp="$(mktemp -d)"
cleanup() { docker rm -f "$task_container" >/dev/null 2>&1 || true; rm -rf "$task_temp"; }
trap cleanup EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for task_attempt in $(seq 1 30); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] && docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
task_psql=(docker exec -i "$task_container" psql -X -U postgres -v ON_ERROR_STOP=1)
"${task_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA app_core;
CREATE SCHEMA experience;
CREATE SCHEMA miniapp_features;
CREATE TABLE app_core.users(id uuid PRIMARY KEY);
CREATE TABLE app_core.characters(id uuid PRIMARY KEY,enabled boolean NOT NULL DEFAULT true,archived_at timestamptz);
CREATE TABLE miniapp_features.character_favorites(character_id uuid NOT NULL REFERENCES app_core.characters,user_id uuid NOT NULL REFERENCES app_core.users,PRIMARY KEY(character_id,user_id));
CREATE TABLE app_core.miniapp_user_settings(user_id uuid PRIMARY KEY REFERENCES app_core.users ON DELETE CASCADE,pref_show_options boolean NOT NULL DEFAULT true,updated_at timestamptz DEFAULT now());
CREATE TABLE app_core.runtime_config(key text PRIMARY KEY,version integer NOT NULL,value jsonb NOT NULL);
CREATE TABLE app_core.text_postprocess_versions(version integer PRIMARY KEY,schema_version integer NOT NULL,policy_version integer NOT NULL,artifact jsonb NOT NULL);
CREATE TABLE experience.chat_sessions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES app_core.users ON DELETE CASCADE,
  character_id uuid NOT NULL REFERENCES app_core.characters ON DELETE RESTRICT,title text,
  last_message_at timestamptz,last_message_preview text,message_count integer NOT NULL DEFAULT 0,
  pinned_at timestamptz,context_window_start_turn integer NOT NULL DEFAULT 1 CHECK(context_window_start_turn>=1),
  deleted_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE experience.chat_history(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES app_core.users ON DELETE CASCADE,
  model text NOT NULL,user_input text NOT NULL,assistant_reply text,history jsonb NOT NULL DEFAULT '[]',
  character_id uuid REFERENCES app_core.characters,status text NOT NULL DEFAULT 'success',upstream_status integer,
  deduction_rate numeric DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),llm_finish_reason text,
  llm_charge_id uuid,llm_billing_snapshot jsonb,llm_billing_settled_at timestamptz,
  session_id uuid REFERENCES experience.chat_sessions ON DELETE SET NULL,turn_index integer,revision integer,
  first_token_preview jsonb,
  UNIQUE(session_id,turn_index,revision)
);
CREATE INDEX idx_chat_history_session_current ON experience.chat_history(session_id,turn_index,revision DESC) WHERE session_id IS NOT NULL AND turn_index IS NOT NULL;
CREATE VIEW experience.current_chat_history WITH(security_invoker=true) AS
SELECT DISTINCT ON(session_id,turn_index) * FROM experience.chat_history
WHERE session_id IS NOT NULL AND turn_index IS NOT NULL AND revision IS NOT NULL
ORDER BY session_id,turn_index,revision DESC;
ALTER TABLE experience.chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience.chat_history ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA app_core,experience,miniapp_features TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA app_core,experience TO service_role,postgres;
ALTER DEFAULT PRIVILEGES IN SCHEMA experience GRANT ALL ON TABLES TO anon,authenticated,service_role;
INSERT INTO app_core.text_postprocess_versions VALUES(1,1,1,'{"schema_version":1,"policy_version":1,"rules":[]}');
INSERT INTO app_core.runtime_config VALUES('miniapp_text_postprocess_config',1,'{"version":1,"schema_version":1,"policy_version":1}');
SQL
# Use the repository's actual prior function bodies, translated only for the completed schema split.
python3 - "$task_root" <<'PY' | "${task_psql[@]}" >/dev/null
import sys
from pathlib import Path
root=Path(sys.argv[1])/'packages/shared/migrations'
a=(root/'072_chat_history_conversation_source.sql').read_text()
for first,last in [('CREATE OR REPLACE FUNCTION miniapp.guard_chat_session_idle(', 'CREATE OR REPLACE FUNCTION miniapp.start_chat_history_turn('),('CREATE OR REPLACE FUNCTION miniapp.tf_refresh_chat_session_stats_from_history()', '-- 旧 M1 表')]:
 print(a[a.index(first):a.index(last,a.index(first))].replace('miniapp.','experience.'))
b=(root/'077_context_window.sql').read_text()
print(b[b.index('CREATE OR REPLACE FUNCTION miniapp.apply_context_window_flood('):b.index('COMMIT;')].replace('miniapp.','experience.'))
PY
for task_migration in \
  20260928_chat_history_postprocess_version.sql \
  20260930_bind_current_text_postprocess_on_turn_start.sql \
  20261013_platform_instruction_slot_windows.sql \
  20261013_session_scoped_instruction_slot_modes.sql \
  20261014_rich_reply_dynamic_mode.sql; do
  "${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/$task_migration" >/dev/null
done
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/20261029_character_social.sql" >/dev/null
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/20261029_conversation_branches.sql" >/dev/null
# Reapplying an unpublished local candidate must preserve objects and all old behavior.
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/20261029_conversation_branches.sql" >/dev/null
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/20261029_chat_message_likes.sql" >/dev/null
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/20261029_chat_message_likes.sql" >/dev/null
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/tests/conversation_branches.sql"
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/20261102_chat_message_overrides.sql" >/dev/null
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/20261102_chat_message_overrides.sql" >/dev/null
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/tests/chat_message_overrides.sql"

# ── story memory: admin managed-config stubs (shape of the real admin schema) ──
"${task_psql[@]}" >/dev/null <<'SQL'
CREATE SCHEMA admin;
CREATE FUNCTION admin.is_managed_config_key(p_config_key text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT p_config_key IN ('system_instructions') $$;
CREATE FUNCTION admin.validate_managed_config_value(p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF NOT admin.is_managed_config_key(p_config_key) THEN RAISE EXCEPTION 'unknown managed key %', p_config_key; END IF;
END $$;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.validate_managed_config_value(text,jsonb,text) TO service_role;
CREATE TABLE admin.config_drafts(config_key text NOT NULL,
  CONSTRAINT config_drafts_config_key_check CHECK (config_key IN ('system_instructions')));
CREATE TABLE admin.config_releases(config_key text NOT NULL,
  CONSTRAINT config_releases_config_key_check CHECK (config_key IN ('system_instructions')));
INSERT INTO app_core.runtime_config VALUES ('max_context_turns',1,'75'),('retain_context_turns',1,'50');
SQL

"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/20261110_story_memory.sql" >/dev/null
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/tests/story_memory.sql"

# Two workers racing for the same due job: exactly one claims it.
"${task_psql[@]}" -Atqc "UPDATE experience.story_memory_jobs SET status='pending', lease_owner=NULL, lease_until=NULL, next_attempt_at=now()-interval '1 second' WHERE session_id='a0000000-0000-4000-8000-000000000001';" >/dev/null
for w in 1 2 3 4; do
  "${task_psql[@]}" -Atqc "SELECT jsonb_array_length(experience.claim_story_memory_jobs('race-$w',20,600));" > "$task_temp/claim-$w" &
done
wait
test "$(cat "$task_temp"/claim-* | paste -sd+ - | bc)" = 1
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/tests/story_memory_cascade.sql"
printf 'PASS: story memory PG17 (flood removed, advance+job, claim/lease, CAS commit, backoff, fork memory selection, managed keys, concurrent claim)\n'
