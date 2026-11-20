#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261121_db_reorg_p6b1b_display_views.sql as a NON-superuser:
# - the fixture views are the production definitions (md5 of pg_get_viewdef matches production);
# - after the switch all three display views return exactly the same rows as before (charged turn, failed turn
#   without a charge id, legacy turn without a charge id, free turn, inherited branch turn);
# - security_invoker stays on; rerun is a no-op; a drifted view is refused; a charge that differs from the turn refuses before any change.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261121_db_reorg_p6b1b_display_views.sql"
task_container="st-db-reorg-p6b1b-views-${RANDOM}-$$"
trap 'docker rm -f "$task_container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE;
CREATE DATABASE fixture OWNER app_admin;
SQL
psql_f() { docker exec -i "$task_container" psql -X -q -U app_admin -d fixture -v ON_ERROR_STOP=1 "$@"; }
check() { # label; SQL on stdin must print exactly "t"
  local got
  got=$(psql_f -At)
  if [[ "$got" != "t" ]]; then echo "FAIL: $1 (got: $got)"; exit 1; fi
  echo "ok: $1"
}
setup() {
  psql_f >/dev/null <<'SQL'
DROP SCHEMA IF EXISTS experience, billing CASCADE;
DROP TABLE IF EXISTS public.before_display, public.before_session_display, public.before_session_history;
CREATE SCHEMA experience; CREATE SCHEMA billing;
-- Column types exactly as in production (11-21).
CREATE TABLE experience.chat_history (id uuid PRIMARY KEY, user_id uuid, model text, user_input text, assistant_reply text,
  character_id uuid, status text, deduction_rate numeric(14,1), created_at timestamptz, llm_finish_reason text,
  llm_charge_id uuid, session_id uuid, turn_index integer, revision integer, postprocess_version integer, rich_reply_metadata jsonb);
CREATE TABLE experience.chat_history_display_metadata (history_id uuid, request_id text, opening_message text);
CREATE TABLE experience.chat_generation_requests (chat_history_id uuid, first_token_preview jsonb);
CREATE TABLE experience.chat_message_overrides (session_id uuid, message_id uuid, role text, content text, deleted boolean, version integer);
CREATE TABLE experience.chat_message_likes (session_id uuid, message_id uuid);
CREATE TABLE experience.chat_branch_turns (session_id uuid, turn_index integer, source_history_id uuid);
CREATE TABLE experience.chat_sessions (id uuid PRIMARY KEY, user_id uuid, character_id uuid);
CREATE TABLE billing.usage_charges (id uuid PRIMARY KEY, charged_credits numeric(14,1) NOT NULL DEFAULT 0);

CREATE VIEW experience.chat_history_display WITH (security_invoker = true) AS
 SELECT h.id, h.user_id, h.model, h.user_input, h.assistant_reply, h.character_id, h.status, h.deduction_rate, h.created_at,
    h.llm_finish_reason, h.llm_charge_id, h.session_id, h.turn_index, h.revision, h.postprocess_version, h.rich_reply_metadata,
    r.first_token_preview, m.request_id AS display_request_id, m.opening_message AS display_opening_message
   FROM experience.chat_history h
     LEFT JOIN experience.chat_history_display_metadata m ON m.history_id = h.id
     LEFT JOIN experience.chat_generation_requests r ON r.chat_history_id = h.id;

CREATE VIEW experience.session_chat_display WITH (security_invoker = true) AS
 SELECT h.id, h.user_id, h.model,
        CASE WHEN u.deleted THEN ''::text ELSE COALESCE(u.content, h.user_input) END AS user_input,
        CASE WHEN a.deleted THEN NULL::text ELSE COALESCE(a.content, h.assistant_reply) END AS assistant_reply,
    h.character_id, h.status, h.deduction_rate, h.created_at, h.llm_finish_reason, h.llm_charge_id, h.session_id, h.turn_index,
    h.revision, h.postprocess_version, h.rich_reply_metadata, h.first_token_preview, false AS is_inherited,
    (EXISTS ( SELECT 1 FROM experience.chat_message_likes l WHERE l.session_id = h.session_id AND l.message_id = h.id)) AS liked,
    COALESCE(u.deleted, false) AS user_deleted, COALESCE(a.deleted, false) AS assistant_deleted,
    COALESCE(u.version, 0) AS user_edit_version, COALESCE(a.version, 0) AS assistant_edit_version,
    h.display_request_id, h.display_opening_message
   FROM experience.chat_history_display h
     LEFT JOIN experience.chat_message_overrides u ON u.session_id = h.session_id AND u.message_id = h.id AND u.role = 'user'::text
     LEFT JOIN experience.chat_message_overrides a ON a.session_id = h.session_id AND a.message_id = h.id AND a.role = 'assistant'::text
  WHERE h.session_id IS NOT NULL AND h.turn_index IS NOT NULL AND h.revision IS NOT NULL AND NOT (EXISTS ( SELECT 1
           FROM experience.chat_history newer
          WHERE newer.session_id = h.session_id AND newer.turn_index = h.turn_index AND newer.revision > h.revision))
UNION ALL
 SELECT h.id, s.user_id, h.model,
        CASE WHEN u.deleted THEN ''::text ELSE COALESCE(u.content, h.user_input) END AS user_input,
        CASE WHEN a.deleted THEN NULL::text ELSE COALESCE(a.content, h.assistant_reply) END AS assistant_reply,
    s.character_id, h.status, NULL::numeric AS deduction_rate, h.created_at, h.llm_finish_reason, NULL::uuid AS llm_charge_id,
    b.session_id, b.turn_index, h.revision, h.postprocess_version, h.rich_reply_metadata, NULL::jsonb AS first_token_preview,
    true AS is_inherited,
    (EXISTS ( SELECT 1 FROM experience.chat_message_likes l WHERE l.session_id = b.session_id AND l.message_id = h.id)) AS liked,
    COALESCE(u.deleted, false) AS user_deleted, COALESCE(a.deleted, false) AS assistant_deleted,
    COALESCE(u.version, 0) AS user_edit_version, COALESCE(a.version, 0) AS assistant_edit_version,
    NULL::text AS display_request_id, h.display_opening_message
   FROM experience.chat_branch_turns b
     JOIN experience.chat_sessions s ON s.id = b.session_id
     JOIN experience.chat_history_display h ON h.id = b.source_history_id AND h.user_id = s.user_id AND h.character_id = s.character_id
     LEFT JOIN experience.chat_message_overrides u ON u.session_id = b.session_id AND u.message_id = h.id AND u.role = 'user'::text
     LEFT JOIN experience.chat_message_overrides a ON a.session_id = b.session_id AND a.message_id = h.id AND a.role = 'assistant'::text
  WHERE NOT (EXISTS ( SELECT 1 FROM experience.chat_history own WHERE own.session_id = b.session_id AND own.turn_index = b.turn_index));

CREATE VIEW experience.session_chat_history WITH (security_invoker = true) AS
 SELECT h.id, h.user_id, h.model,
        CASE WHEN u.deleted THEN ''::text ELSE COALESCE(u.content, h.user_input) END AS user_input,
        CASE WHEN a.deleted THEN NULL::text ELSE COALESCE(a.content, h.assistant_reply) END AS assistant_reply,
    h.character_id, h.status, h.deduction_rate, h.created_at, h.llm_finish_reason, h.llm_charge_id, h.session_id, h.turn_index,
    h.revision, h.postprocess_version, h.rich_reply_metadata, false AS is_inherited,
    (EXISTS ( SELECT 1 FROM experience.chat_message_likes l WHERE l.session_id = h.session_id AND l.message_id = h.id)) AS liked,
    COALESCE(u.deleted, false) AS user_deleted, COALESCE(a.deleted, false) AS assistant_deleted,
    COALESCE(u.version, 0) AS user_edit_version, COALESCE(a.version, 0) AS assistant_edit_version
   FROM ( SELECT DISTINCT ON (c.session_id, c.turn_index) c.id, c.user_id, c.model, c.user_input, c.assistant_reply,
            c.character_id, c.status, c.deduction_rate, c.created_at, c.llm_finish_reason, c.llm_charge_id, c.session_id,
            c.turn_index, c.revision, c.postprocess_version, c.rich_reply_metadata
           FROM experience.chat_history c
          WHERE c.session_id IS NOT NULL AND c.turn_index IS NOT NULL AND c.revision IS NOT NULL
          ORDER BY c.session_id, c.turn_index, c.revision DESC) h
     LEFT JOIN experience.chat_message_overrides u ON u.session_id = h.session_id AND u.message_id = h.id AND u.role = 'user'::text
     LEFT JOIN experience.chat_message_overrides a ON a.session_id = h.session_id AND a.message_id = h.id AND a.role = 'assistant'::text
UNION ALL
 SELECT h.id, s.user_id, h.model,
        CASE WHEN u.deleted THEN ''::text ELSE COALESCE(u.content, h.user_input) END AS user_input,
        CASE WHEN a.deleted THEN NULL::text ELSE COALESCE(a.content, h.assistant_reply) END AS assistant_reply,
    s.character_id, h.status, NULL::numeric AS deduction_rate, h.created_at, h.llm_finish_reason, NULL::uuid AS llm_charge_id,
    inherited.session_id, inherited.turn_index, h.revision, h.postprocess_version, h.rich_reply_metadata, true AS is_inherited,
    (EXISTS ( SELECT 1 FROM experience.chat_message_likes l WHERE l.session_id = inherited.session_id AND l.message_id = h.id)) AS liked,
    COALESCE(u.deleted, false) AS user_deleted, COALESCE(a.deleted, false) AS assistant_deleted,
    COALESCE(u.version, 0) AS user_edit_version, COALESCE(a.version, 0) AS assistant_edit_version
   FROM experience.chat_branch_turns inherited
     JOIN experience.chat_sessions s ON s.id = inherited.session_id
     JOIN experience.chat_history h ON h.id = inherited.source_history_id AND h.user_id = s.user_id AND h.character_id = s.character_id
     LEFT JOIN experience.chat_message_overrides u ON u.session_id = inherited.session_id AND u.message_id = h.id AND u.role = 'user'::text
     LEFT JOIN experience.chat_message_overrides a ON a.session_id = inherited.session_id AND a.message_id = h.id AND a.role = 'assistant'::text
  WHERE NOT (EXISTS ( SELECT 1 FROM experience.chat_history own WHERE own.session_id = inherited.session_id AND own.turn_index = inherited.turn_index));

-- S1: charged (A), failed before admission without a charge id (B), legacy without a charge id (C), free (D, two revisions)
-- S2: a branch that inherits turn A
INSERT INTO experience.chat_sessions VALUES
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1');
INSERT INTO experience.chat_history (id, user_id, model, user_input, assistant_reply, character_id, status, deduction_rate, created_at, llm_charge_id, session_id, turn_index, revision) VALUES
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1', 'm', 'q1', 'r1', '00000000-0000-0000-0000-0000000000c1', 'success', 10, now() - interval '2 days', '00000000-0000-0000-0000-0000000001aa', '00000000-0000-0000-0000-0000000000a1', 1, 0),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000e1', 'm', 'q2', NULL, '00000000-0000-0000-0000-0000000000c1', 'insufficient_balance', 0, now() - interval '2 days', NULL, '00000000-0000-0000-0000-0000000000a1', 2, 0),
  ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-0000000000e1', 'm', 'q3', 'r3', '00000000-0000-0000-0000-0000000000c1', 'success', 5, now() - interval '150 days', NULL, '00000000-0000-0000-0000-0000000000a1', 3, 0),
  ('00000000-0000-0000-0000-0000000000d0', '00000000-0000-0000-0000-0000000000e1', 'm', 'q4', 'r4a', '00000000-0000-0000-0000-0000000000c1', 'success', 0, now() - interval '1 day', '00000000-0000-0000-0000-0000000001d0', '00000000-0000-0000-0000-0000000000a1', 4, 0),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'm', 'q4', 'r4b', '00000000-0000-0000-0000-0000000000c1', 'success', 0, now() - interval '1 day', '00000000-0000-0000-0000-0000000001d1', '00000000-0000-0000-0000-0000000000a1', 4, 1);
INSERT INTO billing.usage_charges VALUES
  ('00000000-0000-0000-0000-0000000001aa', 10), ('00000000-0000-0000-0000-0000000001d0', 0), ('00000000-0000-0000-0000-0000000001d1', 0);
INSERT INTO experience.chat_branch_turns VALUES ('00000000-0000-0000-0000-0000000000a2', 1, '00000000-0000-0000-0000-00000000000a');
INSERT INTO experience.chat_message_likes VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a');
CREATE TABLE public.before_display AS SELECT * FROM experience.chat_history_display;
CREATE TABLE public.before_session_display AS SELECT * FROM experience.session_chat_display;
CREATE TABLE public.before_session_history AS SELECT * FROM experience.session_chat_history;
SQL
}
same_rows() { # label view snapshot
  check "$1" <<SQL
SELECT NOT EXISTS (SELECT * FROM $2 EXCEPT ALL SELECT * FROM public.$3)
   AND NOT EXISTS (SELECT * FROM public.$3 EXCEPT ALL SELECT * FROM $2)
   AND (SELECT count(*) FROM $2) > 0;
SQL
}

setup
check 'fixture views are the production definitions' <<'SQL'
SELECT md5(pg_get_viewdef('experience.chat_history_display'::regclass)) = 'cdb1045f2094b0528e3883740028e0af'
   AND md5(pg_get_viewdef('experience.session_chat_history'::regclass)) = '7497e5308f1a9c5263e713be71870c31'
   AND md5(pg_get_viewdef('experience.session_chat_display'::regclass)) = 'f3ac3291d4193d151f53d1d43f5b9055';
SQL
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'2 display views now read the charge from usage_charges; rows match chat_history'* ]] ||
  { echo "FAIL: apply: $out"; exit 1; }
echo 'ok: applied'
same_rows 'chat_history_display returns the same rows' experience.chat_history_display before_display
same_rows 'session_chat_display returns the same rows' experience.session_chat_display before_session_display
same_rows 'session_chat_history returns the same rows' experience.session_chat_history before_session_history
check 'views read usage_charges, keep security_invoker and numeric(14,1)' <<'SQL'
SELECT position('usage_charges' IN pg_get_viewdef('experience.chat_history_display'::regclass)) > 0
   AND position('usage_charges' IN pg_get_viewdef('experience.session_chat_history'::regclass)) > 0
   AND (SELECT bool_and('security_invoker=true' = ANY(reloptions)) FROM pg_class
        WHERE oid IN ('experience.chat_history_display'::regclass, 'experience.session_chat_history'::regclass))
   AND (SELECT format_type(atttypid, atttypmod) FROM pg_attribute
        WHERE attrelid = 'experience.chat_history_display'::regclass AND attname = 'deduction_rate') = 'numeric(14,1)';
SQL
check 'charged turn now follows usage_charges' <<'SQL'
UPDATE billing.usage_charges SET charged_credits = 12 WHERE id = '00000000-0000-0000-0000-0000000001aa';
SELECT (SELECT deduction_rate FROM experience.session_chat_display WHERE id = '00000000-0000-0000-0000-00000000000a' AND NOT is_inherited) = 12;
SQL
psql_f -c "UPDATE billing.usage_charges SET charged_credits = 10 WHERE id = '00000000-0000-0000-0000-0000000001aa'" >/dev/null
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'0 display views now read'* ]] || { echo "FAIL: rerun: $out"; exit 1; }
echo 'ok: rerun is a no-op'

setup
psql_f -c "CREATE OR REPLACE VIEW experience.chat_history_display WITH (security_invoker = true) AS SELECT h.id, h.user_id, h.model, h.user_input, h.assistant_reply, h.character_id, h.status, h.deduction_rate, h.created_at, h.llm_finish_reason, h.llm_charge_id, h.session_id, h.turn_index, h.revision, h.postprocess_version, h.rich_reply_metadata, NULL::jsonb AS first_token_preview, NULL::text AS display_request_id, NULL::text AS display_opening_message FROM experience.chat_history h" >/dev/null
if out=$(psql_f <"$migration" 2>&1); then echo "FAIL: drift should refuse"; exit 1; fi
[[ "$out" == *'chat_history_display drifted'* ]] || { echo "FAIL: drift message: $out"; exit 1; }
echo 'ok: a drifted view is refused'

setup
psql_f -c "UPDATE billing.usage_charges SET charged_credits = 7 WHERE id = '00000000-0000-0000-0000-0000000001aa'" >/dev/null
if out=$(psql_f <"$migration" 2>&1); then echo "FAIL: mismatch should fail the self-check"; exit 1; fi
[[ "$out" == *'1 turns have usage_charges.charged_credits != chat_history.deduction_rate; refusing'* ]] || { echo "FAIL: mismatch message: $out"; exit 1; }
check 'a mismatch refuses before touching the views' <<'SQL'
SELECT position('usage_charges' IN pg_get_viewdef('experience.chat_history_display'::regclass)) = 0;
SQL
echo 'all checks passed'
