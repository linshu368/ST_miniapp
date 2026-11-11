#!/usr/bin/env bash
# Free zone migration on disposable PG17. No remote URI, user data, model or billing calls.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="free-zone-pg-$$"
cleanup() { docker rm -f "$task_container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] && docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
task_psql=(docker exec -i "$task_container" psql -X -U postgres -v ON_ERROR_STOP=1)

# Stubs shaped like the real objects this migration reads or wraps.
"${task_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE first_token_metrics_reader NOLOGIN;
CREATE SCHEMA experience;
CREATE SCHEMA miniapp_features;
CREATE SCHEMA miniapp_analytics;
CREATE SCHEMA admin;
GRANT USAGE ON SCHEMA miniapp_analytics TO first_token_metrics_reader;
CREATE TABLE experience.surplusintelligence_chat_history(
  chat_history_id uuid PRIMARY KEY, provider_name text, buyer_cost_micro numeric(30,0),
  prompt_tokens bigint, cached_tokens bigint);
CREATE TABLE experience.chat_reply_feedback(created_at timestamptz NOT NULL DEFAULT now(), model_id text NOT NULL);
CREATE TABLE miniapp_analytics.chat_first_token_facts(
  chat_history_id uuid, request_received_at timestamptz, requested_model_id text,
  primary_actual_first_token_ms numeric, delivery_role text, server_first_token_timeout boolean,
  business_finish_reason text);
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
SQL

# Apply twice: a retried workflow run must be a no-op, not a second wrapper.
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/20261112_free_zone.sql" >/dev/null
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/20261112_free_zone.sql" >/dev/null

"${task_psql[@]}" >/dev/null <<'SQL'
DO $assert$
DECLARE v_failed boolean;
BEGIN
  -- managed key chain
  ASSERT admin.is_managed_config_key('free_zone_config');
  ASSERT admin.is_managed_config_key('system_instructions');
  ASSERT NOT admin.is_managed_config_key('__nope__');
  PERFORM admin.validate_managed_config_value('free_zone_config', '{"enabled":false}'::jsonb, NULL);
  BEGIN
    PERFORM admin.validate_managed_config_value('free_zone_config', '[1]'::jsonb, NULL);
    v_failed := false;
  EXCEPTION WHEN invalid_parameter_value THEN v_failed := true;
  END;
  ASSERT v_failed, 'non-object config must be rejected';
  ASSERT has_function_privilege('service_role', 'admin.validate_managed_config_value(text,jsonb,text)', 'EXECUTE');
  ASSERT NOT has_function_privilege('anon', 'admin.validate_managed_config_value(text,jsonb,text)', 'EXECUTE');
  INSERT INTO admin.config_drafts VALUES ('free_zone_config');
  INSERT INTO admin.config_releases VALUES ('free_zone_config');
  BEGIN
    INSERT INTO admin.config_drafts VALUES ('__nope__');
    v_failed := false;
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  ASSERT v_failed, 'unknown key must stay rejected';
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname LIKE '%before_free_zone%') = 2, 'wrapped exactly once';

  -- state invariants
  INSERT INTO miniapp_features.free_zone_models(candidate_id, surplus_model, status, providers)
    VALUES ('free-ds-pro', 'deepseek-v4-pro', 'listed', ARRAY['deepseek']);
  BEGIN
    INSERT INTO miniapp_features.free_zone_models(candidate_id, surplus_model, status)
      VALUES ('free-empty', 'x', 'listed');
    v_failed := false;
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  ASSERT v_failed, 'listed requires providers';
  BEGIN
    INSERT INTO miniapp_features.free_zone_models(candidate_id, surplus_model) VALUES ('paid-model', 'x');
    v_failed := false;
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  ASSERT v_failed, 'candidate id must carry the free- prefix';
  INSERT INTO miniapp_features.free_zone_events(candidate_id, event_type, cause, reason)
    VALUES ('free-ds-pro', 'delisted', 'business', '兜底交付率% 30 > 15');
  INSERT INTO miniapp_features.free_zone_events(candidate_id, event_type, cause, providers, reason)
    VALUES ('free-ds-pro', 'provider_switched', 'official', ARRAY['deepseek'], 'google → deepseek');
  UPDATE miniapp_features.free_zone_models
    SET provider_since = now(), excluded_providers = '{"google":"2026-11-13T00:00:00Z"}'
    WHERE candidate_id = 'free-ds-pro';

  -- projections
  INSERT INTO miniapp_analytics.chat_first_token_facts VALUES
    ('a0000000-0000-4000-8000-000000000001', now(), 'free-ds-pro', 1500, 'primary', false, 'stop'),
    ('a0000000-0000-4000-8000-000000000002', now(), 'free-ds-pro', NULL, 'fallback', false, 'stop'),
    ('a0000000-0000-4000-8000-000000000003', now(), 'model-paid', 900, 'primary', false, 'stop');
  INSERT INTO experience.surplusintelligence_chat_history VALUES
    ('a0000000-0000-4000-8000-000000000001', 'deepseek', 4200, 21000, 15000);
  ASSERT (SELECT count(*) FROM miniapp_analytics.free_zone_turn_facts) = 2, 'only free-zone turns';
  ASSERT (SELECT buyer_cost_usd FROM miniapp_analytics.free_zone_turn_facts WHERE primary_output) = 0.0042;
  ASSERT (SELECT count(*) FROM miniapp_analytics.free_zone_turn_facts WHERE fallback_delivered AND NOT primary_output) = 1;
  ASSERT (SELECT status FROM miniapp_analytics.free_zone_model_states) = 'listed';
  ASSERT (SELECT count(*) FROM miniapp_analytics.free_zone_model_events) = 2;
  ASSERT (SELECT excluded_providers ? 'google' FROM miniapp_analytics.free_zone_model_states);

  -- access
  ASSERT has_table_privilege('first_token_metrics_reader', 'miniapp_analytics.free_zone_turn_facts', 'SELECT');
  ASSERT has_table_privilege('first_token_metrics_reader', 'miniapp_analytics.free_zone_model_events', 'SELECT');
  ASSERT NOT has_table_privilege('first_token_metrics_reader', 'miniapp_features.free_zone_models', 'SELECT');
  ASSERT NOT has_table_privilege('anon', 'miniapp_features.free_zone_models', 'SELECT');
  ASSERT NOT has_table_privilege('authenticated', 'miniapp_analytics.free_zone_turn_facts', 'SELECT');
  ASSERT NOT has_table_privilege('service_role', 'miniapp_features.free_zone_events', 'UPDATE'), 'events are append-only';
END
$assert$;
SQL

# The Grafana role reads through the views without base-table grants.
"${task_psql[@]}" -Atqc "SET ROLE first_token_metrics_reader; SELECT count(*) FROM miniapp_analytics.free_zone_turn_facts;" | grep -qx 2
printf 'PASS: free zone PG17 (managed key chain, state invariants, projections, grants, re-run)\n'
