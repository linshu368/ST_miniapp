#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports, user data, model or billing calls.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="st-conversation-branches-${RANDOM}-$$"
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
# Four independent connections replay the same request after its first result could be lost.
task_pids=()
for task_attempt in 1 2 3 4; do
  "${task_psql[@]}" -Atqc "SELECT experience.fork_chat_session('10000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000301','40000000-0000-4000-8000-000000000099',50)->>'id';" > "$task_temp/replay-$task_attempt" &
  task_pids+=("$!")
done
for task_pid in "${task_pids[@]}"; do wait "$task_pid"; done
test -s "$task_temp/replay-1"
for task_attempt in 2 3 4; do cmp "$task_temp/replay-1" "$task_temp/replay-$task_attempt"; done
# Same target state stays idempotent across separate connections as well.
task_pids=()
for task_attempt in 1 2 3 4; do
  "${task_psql[@]}" -Atqc "SELECT experience.set_chat_message_like('10000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000301',true);" > "$task_temp/like-$task_attempt" &
  task_pids+=("$!")
done
for task_pid in "${task_pids[@]}"; do wait "$task_pid"; done
test -s "$task_temp/like-1"
for task_attempt in 2 3 4; do cmp "$task_temp/like-1" "$task_temp/like-$task_attempt"; done
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
 IF (SELECT count(*) FROM experience.chat_sessions WHERE branch_request_id='40000000-0000-4000-8000-000000000099')<>1 THEN RAISE EXCEPTION 'concurrent request created duplicate branches'; END IF;
 IF (SELECT count(*) FROM experience.chat_message_likes WHERE session_id='20000000-0000-4000-8000-000000000003' AND message_id='30000000-0000-4000-8000-000000000301')<>1 THEN RAISE EXCEPTION 'concurrent feedback created duplicate likes'; END IF;
END $$;
-- All of one account's branch/reference facts disappear in the same transaction.
DELETE FROM app_core.users WHERE id='10000000-0000-4000-8000-000000000001';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM experience.chat_branch_turns b LEFT JOIN experience.chat_history h ON h.id=b.source_history_id WHERE h.id IS NULL) THEN RAISE EXCEPTION 'dangling inherited reference'; END IF;
 IF EXISTS(SELECT 1 FROM experience.chat_sessions WHERE user_id='10000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'account sessions not deleted'; END IF;
END $$;
DELETE FROM app_core.users WHERE id='10000000-0000-4000-8000-000000000002';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM experience.chat_message_likes l LEFT JOIN experience.chat_sessions s ON s.id=l.session_id LEFT JOIN experience.chat_history h ON h.id=l.message_id WHERE s.id IS NULL OR h.id IS NULL) THEN RAISE EXCEPTION 'account deletion left dangling likes'; END IF;
END $$;
SQL
printf 'PASS: conversation branches and reply likes PG17 (context, revision, independence, windows, auth, idempotency, concurrency, accounting isolation, account cascade)\n'
