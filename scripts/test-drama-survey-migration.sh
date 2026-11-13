#!/usr/bin/env bash
# Drama survey migration on disposable PG17. No remote URI, user data or real wallet calls.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="drama-survey-pg-$$"
cleanup() { docker rm -f "$task_container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] && docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
task_psql=(docker exec -i "$task_container" psql -X -U postgres -v ON_ERROR_STOP=1)

# Stubs shaped like the real objects this migration reads or writes.
"${task_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA app_core;
CREATE SCHEMA billing;
GRANT USAGE ON SCHEMA billing TO service_role;
CREATE TABLE app_core.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE app_core.runtime_config(
  key text PRIMARY KEY, value jsonb, description text, version integer,
  updated_at timestamptz, text_value text);
CREATE TABLE billing.user_wallets(
  user_id uuid PRIMARY KEY REFERENCES app_core.users(id),
  main_credits integer NOT NULL DEFAULT 0,
  bonus_credits integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE billing.wallet_ledger(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, entry_type text NOT NULL, amount integer NOT NULL,
  main_delta integer NOT NULL, bonus_delta integer NOT NULL,
  balance_main integer NOT NULL, balance_bonus integer NOT NULL,
  reference_type text, reference_id text, metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_ledger_entry_type_check CHECK (entry_type IN ('recharge','chat_debit','community_reward')));
INSERT INTO app_core.users(id) VALUES
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');
INSERT INTO billing.user_wallets(user_id, main_credits, bonus_credits)
  VALUES ('00000000-0000-4000-8000-000000000001', 30, 5);
SQL

# Apply twice: a retried workflow run must be a no-op.
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/20261113_drama_survey.sql" >/dev/null
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/20261113_drama_survey.sql" >/dev/null

"${task_psql[@]}" >/dev/null <<'SQL'
DO $assert$
DECLARE
  u1 uuid := '00000000-0000-4000-8000-000000000001';
  u2 uuid := '00000000-0000-4000-8000-000000000002';
  v_status text; v_credits integer; v_failed boolean;
BEGIN
  -- ledger kinds: old kinds kept, survey_reward added, unknown still rejected
  INSERT INTO billing.wallet_ledger(user_id,entry_type,amount,main_delta,bonus_delta,balance_main,balance_bonus)
    VALUES (u2,'chat_debit',-1,-1,0,0,0);
  v_failed := false;
  BEGIN
    INSERT INTO billing.wallet_ledger(user_id,entry_type,amount,main_delta,bonus_delta,balance_main,balance_bonus)
      VALUES (u2,'made_up',1,1,0,0,0);
  EXCEPTION WHEN check_violation THEN v_failed := true; END;
  ASSERT v_failed, 'unknown ledger kind must be rejected';
  DELETE FROM billing.wallet_ledger;

  ASSERT (SELECT value FROM app_core.runtime_config WHERE key='miniapp_drama_survey_enabled') = 'false'::jsonb;

  -- dismissed first, then submitted: reward once, dismissal overwritten
  INSERT INTO miniapp_analytics.drama_survey_responses(survey_key,user_id,status,engaged_dramas,max_episode)
    VALUES ('drama_reason_v1',u1,'dismissed',1,1);
  SELECT result_status, result_credits INTO v_status, v_credits FROM billing.submit_drama_survey(
    u1,'drama_reason_v1',200,ARRAY['chat_only'],NULL,ARRAY['slow_start','other'],' 太慢 ',' 想看更多 ','ios',2,3);
  ASSERT v_status = 'rewarded' AND v_credits = 200, 'first submit must reward';
  ASSERT (SELECT bonus_credits FROM billing.user_wallets WHERE user_id=u1) = 205;
  ASSERT (SELECT main_credits FROM billing.user_wallets WHERE user_id=u1) = 30, 'main credits untouched';
  ASSERT (SELECT count(*) FROM billing.wallet_ledger WHERE user_id=u1 AND entry_type='survey_reward'
          AND bonus_delta=200 AND main_delta=0 AND balance_bonus=205 AND reference_type='survey'
          AND reference_id='drama_reason_v1') = 1;
  ASSERT (SELECT status='submitted' AND watch_other_text='太慢' AND open_other_text IS NULL AND comment='想看更多'
          AND engaged_dramas=2 AND max_episode=3 AND wallet_ledger_id IS NOT NULL
          FROM miniapp_analytics.drama_survey_responses WHERE user_id=u1);

  -- repeat submit: no second reward, first answers kept
  SELECT result_status, result_credits INTO v_status, v_credits FROM billing.submit_drama_survey(
    u1,'drama_reason_v1',200,ARRAY['other'],'x',ARRAY['stutter'],NULL,NULL,'android',1,1);
  ASSERT v_status = 'already_rewarded' AND v_credits = 200;
  ASSERT (SELECT bonus_credits FROM billing.user_wallets WHERE user_id=u1) = 205;
  ASSERT (SELECT count(*) FROM billing.wallet_ledger WHERE entry_type='survey_reward') = 1;
  ASSERT (SELECT watch_reasons FROM miniapp_analytics.drama_survey_responses WHERE user_id=u1) = ARRAY['slow_start','other'];

  -- user without wallet row and without dismissal
  SELECT result_status INTO v_status FROM billing.submit_drama_survey(
    u2,'drama_reason_v1',200,ARRAY['distrust_ai'],'',ARRAY['boring_plot'],'',NULL,NULL,1,1);
  ASSERT v_status = 'rewarded';
  ASSERT (SELECT bonus_credits FROM billing.user_wallets WHERE user_id=u2) = 200;
  ASSERT (SELECT open_other_text IS NULL AND watch_other_text IS NULL AND platform IS NULL
          FROM miniapp_analytics.drama_survey_responses WHERE user_id=u2);

  -- dismissal after submission must not downgrade the row
  INSERT INTO miniapp_analytics.drama_survey_responses(survey_key,user_id,status)
    VALUES ('drama_reason_v1',u2,'dismissed') ON CONFLICT DO NOTHING;
  ASSERT (SELECT status FROM miniapp_analytics.drama_survey_responses WHERE user_id=u2) = 'submitted';

  -- invalid input
  v_failed := false;
  BEGIN PERFORM billing.submit_drama_survey(u1,'drama_reason_v2',0,ARRAY['other'],NULL,ARRAY['other'],NULL,NULL,NULL,1,1);
  EXCEPTION WHEN SQLSTATE '22023' THEN v_failed := true; END;
  ASSERT v_failed, 'non-positive reward must be rejected';
  v_failed := false;
  BEGIN PERFORM billing.submit_drama_survey(u1,'drama_reason_v2',200,ARRAY['other'],NULL,ARRAY['a','b','c'],NULL,NULL,NULL,1,1);
  EXCEPTION WHEN check_violation THEN v_failed := true; END;
  ASSERT v_failed, 'more than two reasons must be rejected';
  v_failed := false;
  BEGIN PERFORM billing.submit_drama_survey(u1,'drama_reason_v2',200,ARRAY[]::text[],NULL,ARRAY['stutter'],NULL,NULL,NULL,1,1);
  EXCEPTION WHEN check_violation THEN v_failed := true; END;
  ASSERT v_failed, 'submitted row without Q2a answer must be rejected';
  v_failed := false;
  BEGIN PERFORM billing.submit_drama_survey(u1,'drama_reason_v2',200,ARRAY['other'],NULL,ARRAY['stutter'],NULL,NULL,NULL,NULL,1);
  EXCEPTION WHEN check_violation THEN v_failed := true; END;
  ASSERT v_failed, 'submitted row without engagement depth must be rejected';
  ASSERT NOT EXISTS (SELECT 1 FROM miniapp_analytics.drama_survey_responses WHERE survey_key='drama_reason_v2');
  ASSERT (SELECT count(*) FROM billing.wallet_ledger WHERE entry_type='survey_reward') = 2, 'failed submit must not pay';

  -- grants
  ASSERT has_function_privilege('service_role','billing.submit_drama_survey(uuid,text,integer,text[],text,text[],text,text,text,integer,integer)','EXECUTE');
  ASSERT NOT has_function_privilege('anon','billing.submit_drama_survey(uuid,text,integer,text[],text,text[],text,text,text,integer,integer)','EXECUTE');
  ASSERT NOT has_function_privilege('authenticated','billing.submit_drama_survey(uuid,text,integer,text[],text,text[],text,text,text,integer,integer)','EXECUTE');
  ASSERT has_table_privilege('service_role','miniapp_analytics.drama_survey_responses','SELECT,INSERT');
  ASSERT NOT has_table_privilege('service_role','miniapp_analytics.drama_survey_responses','UPDATE');
  ASSERT NOT has_table_privilege('anon','miniapp_analytics.drama_survey_responses','SELECT');
  ASSERT NOT has_table_privilege('authenticated','miniapp_analytics.drama_survey_responses','SELECT');
END $assert$;
SQL

# Concurrent submits for the same account: exactly one reward.
"${task_psql[@]}" >/dev/null <<'SQL'
INSERT INTO app_core.users(id) VALUES ('00000000-0000-4000-8000-000000000003');
SQL
for _ in 1 2 3 4; do
  docker exec "$task_container" psql -X -U postgres -v ON_ERROR_STOP=1 -qAt -c \
    "SELECT result_status FROM billing.submit_drama_survey('00000000-0000-4000-8000-000000000003','drama_reason_v1',200,ARRAY['chat_only'],NULL,ARRAY['slow_start'],NULL,NULL,NULL,1,1)" &
done
wait
"${task_psql[@]}" >/dev/null <<'SQL'
DO $assert$ BEGIN
  ASSERT (SELECT count(*) FROM billing.wallet_ledger
          WHERE user_id='00000000-0000-4000-8000-000000000003' AND entry_type='survey_reward') = 1,
    'concurrent submits must reward once';
  ASSERT (SELECT bonus_credits FROM billing.user_wallets
          WHERE user_id='00000000-0000-4000-8000-000000000003') = 200;
END $assert$;
SQL

echo "drama survey migration: ok"
