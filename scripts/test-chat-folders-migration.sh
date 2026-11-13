#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports, user data, model or billing calls.
# Verifies 20261113_chat_folders.sql: idempotent re-run, ownership FK, column-scoped SET NULL,
# summary/group functions and ACL.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="st-chat-folders-${RANDOM}-$$"
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
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA app_core;
CREATE SCHEMA experience;
CREATE TABLE app_core.users(id uuid PRIMARY KEY);
CREATE TABLE app_core.characters(id uuid PRIMARY KEY);
CREATE TABLE experience.chat_sessions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_core.users ON DELETE CASCADE,
  character_id uuid NOT NULL REFERENCES app_core.characters ON DELETE RESTRICT,
  title text, last_message_at timestamptz, last_message_preview text,
  message_count integer NOT NULL DEFAULT 0, pinned_at timestamptz,
  deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT USAGE ON SCHEMA experience TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON experience.chat_sessions TO service_role;
SQL

migration="$task_root/packages/shared/migrations/20261113_chat_folders.sql"
"${task_psql[@]}" >/dev/null < "$migration"
# Re-running must be a no-op rather than an error.
"${task_psql[@]}" >/dev/null < "$migration"

"${task_psql[@]}" <<'SQL'
\set QUIET on
INSERT INTO app_core.users VALUES ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002');
INSERT INTO app_core.characters VALUES ('10000000-0000-4000-8000-000000000001'), ('10000000-0000-4000-8000-000000000002');
-- user 1: three sessions with character A (one pinned), one with B, one empty (message_count 0), one deleted.
INSERT INTO experience.chat_sessions(id,user_id,character_id,title,last_message_at,message_count,pinned_at,deleted_at) VALUES
 ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','A1',now()-interval '3 hours',5,NULL,NULL),
 ('20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','A2',now()-interval '1 hour',3,NULL,NULL),
 ('20000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','A3',now()-interval '5 days',2,now(),NULL),
 ('20000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','B1',now()-interval '2 hours',8,NULL,NULL),
 ('20000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','B-empty',NULL,0,NULL,NULL),
 ('20000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','B-deleted',now(),4,NULL,now());
INSERT INTO experience.chat_folders(id,user_id,name) VALUES
 ('30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','主线剧情'),
 ('30000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','别人的分组');
UPDATE experience.chat_sessions SET folder_id='30000000-0000-4000-8000-000000000001'
 WHERE id IN ('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000004');

DO $t$
DECLARE v jsonb; v_user uuid; v_folder uuid;
BEGIN
  -- Ownership: another user's folder is rejected by the composite FK.
  BEGIN
    UPDATE experience.chat_sessions SET folder_id='30000000-0000-4000-8000-000000000002'
     WHERE id='20000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'cross-user folder accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  -- Name rules.
  BEGIN INSERT INTO experience.chat_folders(user_id,name) VALUES ('00000000-0000-4000-8000-000000000001','主线剧情');
    RAISE EXCEPTION 'duplicate name accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN INSERT INTO experience.chat_folders(user_id,name) VALUES ('00000000-0000-4000-8000-000000000001',' 带空格 ');
    RAISE EXCEPTION 'untrimmed name accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO experience.chat_folders(user_id,name) VALUES ('00000000-0000-4000-8000-000000000001','一二三四五六七八九十一二三');
    RAISE EXCEPTION '13-char name accepted'; EXCEPTION WHEN check_violation THEN NULL; END;

  -- Summary counts only visible sessions (not deleted, message_count > 0).
  v := experience.chat_folder_summary('00000000-0000-4000-8000-000000000001');
  IF (v->>'all')::int <> 4 OR (v->>'ungrouped')::int <> 2 OR jsonb_array_length(v->'folders') <> 1
     OR (v->'folders'->0->>'session_count')::int <> 2 THEN
    RAISE EXCEPTION 'summary mismatch: %', v;
  END IF;

  -- Groups: character A (one part pinned) leads with its LATEST part A2, 3 parts, group pinned → first.
  v := experience.list_chat_session_groups('00000000-0000-4000-8000-000000000001', NULL, false, 20, 0);
  IF (v->>'total')::int <> 2 OR v->'groups'->0->'session'->>'title' <> 'A2'
     OR (v->'groups'->0->>'session_count')::int <> 3 OR v->'groups'->0->>'pinned_at' IS NULL
     OR (v->'groups'->1->>'session_count')::int <> 1 OR v->'groups'->1->>'pinned_at' IS NOT NULL
     OR v->'groups'->0->'session' ? 'group_rank' OR v->'groups'->0->'session' ? 'group_pinned_at' THEN
    RAISE EXCEPTION 'groups mismatch: %', v;
  END IF;
  -- Unpinned: groups ordered by each character's latest part (A2 1h ago beats B1 2h ago).
  UPDATE experience.chat_sessions SET pinned_at = NULL WHERE id = '20000000-0000-4000-8000-000000000003';
  v := experience.list_chat_session_groups('00000000-0000-4000-8000-000000000001', NULL, false, 20, 0);
  IF v->'groups'->0->'session'->>'title' <> 'A2' OR v->'groups'->1->'session'->>'title' <> 'B1' THEN
    RAISE EXCEPTION 'latest-time ordering mismatch: %', v;
  END IF;
  UPDATE experience.chat_sessions SET last_message_at = now() WHERE id = '20000000-0000-4000-8000-000000000004';
  v := experience.list_chat_session_groups('00000000-0000-4000-8000-000000000001', NULL, false, 20, 0);
  IF v->'groups'->0->'session'->>'title' <> 'B1' THEN
    RAISE EXCEPTION 'latest-time reorder mismatch: %', v;
  END IF;
  v := experience.list_chat_session_groups('00000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', false, 20, 0);
  IF (v->>'total')::int <> 2 OR (v->'groups'->0->>'session_count')::int <> 1 THEN
    RAISE EXCEPTION 'folder groups mismatch: %', v;
  END IF;
  v := experience.list_chat_session_groups('00000000-0000-4000-8000-000000000001', NULL, true, 1, 1);
  IF (v->>'total')::int <> 1 OR jsonb_array_length(v->'groups') <> 0 THEN
    RAISE EXCEPTION 'ungrouped paging mismatch: %', v;
  END IF;

  -- Deleting a folder clears only folder_id; sessions and user_id stay.
  DELETE FROM experience.chat_folders WHERE id='30000000-0000-4000-8000-000000000001';
  SELECT user_id, folder_id INTO v_user, v_folder FROM experience.chat_sessions WHERE id='20000000-0000-4000-8000-000000000001';
  IF v_user IS DISTINCT FROM '00000000-0000-4000-8000-000000000001'::uuid OR v_folder IS NOT NULL THEN
    RAISE EXCEPTION 'folder delete did not clear only folder_id';
  END IF;

  -- ACL.
  IF has_table_privilege('anon','experience.chat_folders','SELECT')
     OR has_function_privilege('authenticated','experience.chat_folder_summary(uuid)','EXECUTE')
     OR NOT has_table_privilege('service_role','experience.chat_folders','DELETE') THEN
    RAISE EXCEPTION 'acl mismatch';
  END IF;

  -- Deleting the user cascades folders.
  DELETE FROM experience.chat_sessions WHERE user_id='00000000-0000-4000-8000-000000000002';
  DELETE FROM app_core.users WHERE id='00000000-0000-4000-8000-000000000002';
  IF EXISTS (SELECT 1 FROM experience.chat_folders WHERE user_id='00000000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'user delete did not cascade folders';
  END IF;
END $t$;
SELECT 'chat folders migration: ok' AS result;
SQL
