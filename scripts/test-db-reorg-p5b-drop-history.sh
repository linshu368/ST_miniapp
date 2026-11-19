#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261119_db_reorg_p5b_drop_history.sql as a NON-superuser:
# - drops experience.chat_history.history when every guard holds; other columns and rows are untouched; a rerun
#   only prints "already dropped";
# - production-shaped function bodies that merely mention 'history' (the table alias history.<col>, the jsonb key
#   p_input->'history', "started history row" messages) do not trip the function guard;
# - it refuses and keeps the column when: a turn created after the 5a cutover carries history, a recent frozen prompt is missing from
#   ops.chat_prompt_observations, a function still reads h.history, or a view depends on the column.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261119_db_reorg_p5b_drop_history.sql"
task_container="st-db-reorg-p5b-drop-${RANDOM}-$$"
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
has_history() { psql_f -At -c "SELECT count(*) FROM pg_attribute WHERE attrelid = 'experience.chat_history'::regclass AND attname = 'history' AND NOT attisdropped"; }
fixture() {
  psql_f >/dev/null <<'SQL'
DROP SCHEMA IF EXISTS experience, ops CASCADE;
CREATE SCHEMA experience; CREATE SCHEMA ops;
CREATE TABLE experience.chat_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
  session_id uuid, user_input text, assistant_reply text, rich_reply_metadata jsonb,
  history jsonb, llm_billing_snapshot jsonb);
CREATE TABLE ops.chat_prompt_observations (
  history_id uuid PRIMARY KEY, messages_snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
-- old turns (history kept until the column goes), all recent frozen prompts copied to ops; new turns have no history
INSERT INTO experience.chat_history (created_at, assistant_reply, history, llm_billing_snapshot)
SELECT now() - g * interval '1 day', 'r' || g, '[{"role":"system"},{"role":"user"}]', '{}'
FROM generate_series(2, 30) g;
INSERT INTO ops.chat_prompt_observations (history_id, messages_snapshot)
SELECT id, history FROM experience.chat_history WHERE created_at >= now() - interval '7 days';
INSERT INTO experience.chat_history (created_at, assistant_reply, history, llm_billing_snapshot)
SELECT now() - interval '3 days', 'marker', '[{"request_id":"x"}]', NULL FROM generate_series(1, 3);
INSERT INTO experience.chat_history (assistant_reply, llm_billing_snapshot) SELECT 'new' || g, '{}' FROM generate_series(1, 5) g;
-- production-shaped mentions of the word history that are not column uses
CREATE FUNCTION experience.start_turn_like(p_session_id uuid) RETURNS boolean LANGUAGE plpgsql AS $f$
DECLARE v boolean;
BEGIN
  SELECT COALESCE(history.rich_reply_metadata ->> 'rich_reply_result' = 'exact', false) INTO v
  FROM experience.chat_history AS history
  WHERE history.session_id = p_session_id ORDER BY history.created_at DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'started history row disappeared'; END IF;
  RETURN v;
END $f$;
CREATE FUNCTION experience.begin_like(p_history_id uuid, p_input jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_history jsonb := p_input->'history';
BEGIN
  IF p_input ? 'history' THEN
    INSERT INTO ops.chat_prompt_observations(history_id, messages_snapshot) VALUES (p_history_id, v_history)
    ON CONFLICT (history_id) DO NOTHING;
  END IF;
  UPDATE experience.chat_history SET llm_billing_snapshot = p_input->'snapshot' WHERE id = p_history_id;
END $f$;
SQL
}

# 1. Production shape: dropped; rerun is a no-op.
fixture
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'chat_history.history dropped'* ]] || { echo "FAIL: first apply output: $out"; exit 1; }
check 'history dropped, rows and other columns untouched, ops copy kept' <<'SQL'
SELECT NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'experience.chat_history'::regclass
                   AND attname = 'history' AND NOT attisdropped)
  AND (SELECT count(*) FROM experience.chat_history) = 37
  AND (SELECT count(*) FROM experience.chat_history WHERE assistant_reply IS NOT NULL) = 37
  AND (SELECT count(*) FROM ops.chat_prompt_observations) = 5;
SQL
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'already dropped'* ]] || { echo "FAIL: rerun output: $out"; exit 1; }
echo 'ok: rerun prints already dropped'

# 2. Refusals keep the column.
refuses() { # label; expected message; setup SQL on stdin
  fixture
  psql_f >/dev/null
  local out
  if out=$(psql_f <"$migration" 2>&1); then echo "FAIL: not refused: $1"; exit 1; fi
  [[ "$out" == *"$2"* ]] || { echo "FAIL: $1 refused for another reason: $out"; exit 1; }
  [[ "$(has_history)" == 1 ]] || { echo "FAIL: column gone after refusal: $1"; exit 1; }
  echo "ok: refused and kept the column: $1"
}
# Fixture times are relative to now(): old turns are >= 2 days old, i.e. before the 2026-11-18 20:00 UTC cutover
# while this verification is run (11-19); new turns are created now.
refuses 'turn after the 5a cutover carries history' 'after the 5a cutover still carry history' <<'SQL'
UPDATE experience.chat_history SET history = '[{"role":"system"},{"role":"user"}]' WHERE assistant_reply = 'new1';
SQL
refuses 'recent frozen prompt missing from ops' 'are not in ops.chat_prompt_observations' <<'SQL'
DELETE FROM ops.chat_prompt_observations
WHERE history_id = (SELECT id FROM experience.chat_history WHERE assistant_reply = 'r3');
SQL
refuses 'function still reads h.history' 'functions may still use chat_history.history' <<'SQL'
CREATE FUNCTION experience.old_reader(p_id uuid) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT h.history FROM experience.chat_history h WHERE h.id = p_id $f$;
SQL
refuses 'view depends on the column' 'depend' <<'SQL'
CREATE VIEW experience.prompt_view AS SELECT id, history FROM experience.chat_history;
SQL
echo 'all checks passed'
