#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261117_db_reorg_p3b1_user_marks.sql (+ _contract) as a NON-superuser with CREATEROLE:
# - expand is idempotent; growth_prompt_states rows, vip_entry_seen_at and characters_last_seen_at land in user_marks unchanged;
# - record_growth_prompt_event keeps its cap / interval / action semantics; touch_user_mark counts and keeps first_at;
# - release window: old backend writes on settings reach user_marks, new writes via touch_user_mark reach settings,
#   without loops or double counting; old readers still read growth_prompt_states (compat view) and slot preferences;
# - legacy *_full_rules_remaining counters, claim functions and trigger are gone;
# - contract reconciles leftovers written only to settings, refuses when share_image_plaza_artifact's settings upsert
#   was changed by someone else, then drops the compat objects and columns; share still works and first share is
#   derivable from billing.image_plaza_share_rewards exactly as the old column said; idempotent;
# - pre-step clears first-share times without a reward record (hand-edited test data) that block the contract.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
expand="$task_root/packages/shared/migrations/20261117_db_reorg_p3b1_user_marks.sql"
contract="$task_root/packages/shared/migrations/20261117_db_reorg_p3b1_user_marks_contract.sql"
clear_orphan="$task_root/packages/shared/migrations/20261117_db_reorg_p3b1_clear_orphan_first_share.sql"
task_container="st-db-reorg-p3b1-${RANDOM}-$$"
trap 'docker rm -f "$task_container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
super_psql=(docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1)
admin_psql=(docker exec -i "$task_container" psql -X -q -U app_admin -d postgres -v ON_ERROR_STOP=1)

"${super_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE BYPASSRLS;
GRANT CREATE, CONNECT ON DATABASE postgres TO app_admin;
SQL

# Fixture mirrors the production shape collected on 2026-11-17 (function bodies copied from production).
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT service_role, anon, authenticated TO app_admin;
CREATE SCHEMA app_core; CREATE SCHEMA miniapp_features; CREATE SCHEMA billing; CREATE SCHEMA media_plaza;
CREATE SCHEMA test_fixture;
GRANT USAGE ON SCHEMA app_core, miniapp_features, billing, media_plaza TO service_role;

CREATE TABLE app_core.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tg_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE app_core.miniapp_user_settings (
  user_id uuid PRIMARY KEY REFERENCES app_core.users(id) ON DELETE CASCADE,
  tg_username text, tg_first_name text, display_name text,
  pref_show_options boolean NOT NULL DEFAULT true,
  pref_show_status boolean NOT NULL DEFAULT true,
  pref_show_memory boolean NOT NULL DEFAULT true,
  characters_last_seen_at timestamptz,
  vip_entry_seen_at timestamptz,
  choice_full_rules_remaining smallint NOT NULL DEFAULT 2 CHECK (choice_full_rules_remaining BETWEEN 0 AND 2),
  status_full_rules_remaining smallint NOT NULL DEFAULT 2 CHECK (status_full_rules_remaining BETWEEN 0 AND 2),
  memory_full_rules_remaining smallint NOT NULL DEFAULT 2 CHECK (memory_full_rules_remaining BETWEEN 0 AND 2),
  image_plaza_first_share_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE app_core.miniapp_user_settings ENABLE ROW LEVEL SECURITY;
GRANT ALL ON app_core.miniapp_user_settings TO service_role;

CREATE FUNCTION app_core.instruction_slot_claim_enter() RETURNS void LANGUAGE plpgsql SET search_path TO 'pg_catalog' AS $function$
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS instruction_slot_claim_guard (id integer PRIMARY KEY) ON COMMIT DROP;
  INSERT INTO pg_temp.instruction_slot_claim_guard (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
END;
$function$;
CREATE FUNCTION app_core.instruction_slot_claim_ok() RETURNS boolean LANGUAGE plpgsql SET search_path TO 'pg_catalog' AS $function$
DECLARE v_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(proc.proowner) INTO v_owner
  FROM pg_catalog.pg_proc AS proc
  WHERE proc.oid = 'app_core.instruction_slot_claim_enter()'::regprocedure;
  RETURN current_user IS NOT DISTINCT FROM v_owner
    AND to_regclass('pg_temp.instruction_slot_claim_guard') IS NOT NULL;
END;
$function$;
CREATE FUNCTION app_core.apply_instruction_slot_preference_window() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'pg_catalog' AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.choice_full_rules_remaining := CASE WHEN NEW.pref_show_options THEN 2 ELSE 0 END;
    NEW.status_full_rules_remaining := CASE WHEN NEW.pref_show_status THEN 2 ELSE 0 END;
    NEW.memory_full_rules_remaining := CASE WHEN NEW.pref_show_memory THEN 2 ELSE 0 END;
    RETURN NEW;
  END IF;
  IF NEW.pref_show_options IS DISTINCT FROM OLD.pref_show_options THEN
    NEW.choice_full_rules_remaining := CASE WHEN NEW.pref_show_options THEN 2 ELSE 0 END;
  ELSIF NEW.choice_full_rules_remaining IS DISTINCT FROM OLD.choice_full_rules_remaining THEN
    IF NOT app_core.instruction_slot_claim_ok() THEN
      RAISE EXCEPTION 'choice_full_rules_remaining is only changed while claiming a turn or switching its preference' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.pref_show_status IS DISTINCT FROM OLD.pref_show_status THEN
    NEW.status_full_rules_remaining := CASE WHEN NEW.pref_show_status THEN 2 ELSE 0 END;
  END IF;
  IF NEW.pref_show_memory IS DISTINCT FROM OLD.pref_show_memory THEN
    NEW.memory_full_rules_remaining := CASE WHEN NEW.pref_show_memory THEN 2 ELSE 0 END;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_apply_instruction_slot_preference_window BEFORE INSERT OR UPDATE OF pref_show_options, pref_show_status,
  pref_show_memory, choice_full_rules_remaining, status_full_rules_remaining, memory_full_rules_remaining
  ON app_core.miniapp_user_settings FOR EACH ROW EXECUTE FUNCTION app_core.apply_instruction_slot_preference_window();
CREATE FUNCTION app_core.claim_instruction_slot_modes(p_user_id uuid)
 RETURNS TABLE(choice_rules_mode text, status_rules_mode text, memory_rules_mode text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog' AS $function$
DECLARE
  v_settings app_core.miniapp_user_settings%ROWTYPE;
BEGIN
  SELECT * INTO v_settings FROM app_core.miniapp_user_settings WHERE user_id = p_user_id FOR UPDATE;
  choice_rules_mode := CASE WHEN NOT v_settings.pref_show_options THEN 'off'
    WHEN v_settings.choice_full_rules_remaining > 0 THEN 'full' ELSE 'concise' END;
  status_rules_mode := 'off'; memory_rules_mode := 'off';
  PERFORM app_core.instruction_slot_claim_enter();
  RETURN NEXT;
END;
$function$;
CREATE FUNCTION app_core.update_instruction_slot_preferences(p_user_id uuid, p_pref_show_options boolean DEFAULT NULL::boolean,
  p_pref_show_status boolean DEFAULT NULL::boolean, p_pref_show_memory boolean DEFAULT NULL::boolean)
 RETURNS TABLE(pref_show_options boolean, pref_show_status boolean, pref_show_memory boolean)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog' AS $function$
BEGIN
  UPDATE app_core.miniapp_user_settings AS settings
  SET pref_show_options = COALESCE(p_pref_show_options, settings.pref_show_options),
      pref_show_status = COALESCE(p_pref_show_status, settings.pref_show_status),
      pref_show_memory = COALESCE(p_pref_show_memory, settings.pref_show_memory),
      updated_at = pg_catalog.now()
  WHERE settings.user_id = p_user_id
  RETURNING settings.pref_show_options, settings.pref_show_status, settings.pref_show_memory
    INTO pref_show_options, pref_show_status, pref_show_memory;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'miniapp user settings not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN NEXT;
END;
$function$;

CREATE TABLE miniapp_features.growth_prompt_states (
  user_id uuid NOT NULL, prompt text NOT NULL CHECK (prompt = ANY (ARRAY['community'::text, 'vip'::text])),
  shown_count integer NOT NULL DEFAULT 0 CHECK (shown_count >= 0), first_shown_at timestamptz, last_shown_at timestamptz,
  last_action text CHECK (last_action = ANY (ARRAY['accepted'::text, 'dismissed'::text])), last_action_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT growth_prompt_states_pkey PRIMARY KEY (user_id, prompt),
  CONSTRAINT growth_prompt_states_user_fkey FOREIGN KEY (user_id) REFERENCES app_core.users(id) ON DELETE CASCADE);
ALTER TABLE miniapp_features.growth_prompt_states ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON miniapp_features.growth_prompt_states TO service_role;
CREATE FUNCTION miniapp_features.record_growth_prompt_event(p_user_id uuid, p_prompt text, p_event text, p_max_shows integer, p_min_interval_seconds integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog' SET statement_timeout TO '3s' AS $function$
DECLARE
  v_count integer;
BEGIN
  IF p_user_id IS NULL OR p_prompt NOT IN ('community', 'vip')
    OR p_event NOT IN ('shown', 'accepted', 'dismissed') THEN
    RAISE EXCEPTION 'invalid growth prompt event';
  END IF;
  IF p_event = 'shown' THEN
    INSERT INTO miniapp_features.growth_prompt_states AS s
      (user_id, prompt, shown_count, first_shown_at, last_shown_at, updated_at)
    VALUES (p_user_id, p_prompt, 1, clock_timestamp(), clock_timestamp(), clock_timestamp())
    ON CONFLICT (user_id, prompt) DO UPDATE
      SET shown_count = s.shown_count + 1,
          first_shown_at = COALESCE(s.first_shown_at, EXCLUDED.first_shown_at),
          last_shown_at = EXCLUDED.last_shown_at,
          updated_at = EXCLUDED.updated_at
      WHERE s.shown_count < GREATEST(COALESCE(p_max_shows, 0), 0)
        AND (s.last_shown_at IS NULL
          OR s.last_shown_at <= clock_timestamp() - make_interval(secs => GREATEST(COALESCE(p_min_interval_seconds, 0), 0)))
    RETURNING s.shown_count INTO v_count;
    IF v_count IS NULL THEN
      SELECT shown_count INTO v_count FROM miniapp_features.growth_prompt_states
        WHERE user_id = p_user_id AND prompt = p_prompt;
      RETURN jsonb_build_object('recorded', false, 'shown_count', COALESCE(v_count, 0));
    END IF;
    RETURN jsonb_build_object('recorded', true, 'shown_count', v_count);
  END IF;
  UPDATE miniapp_features.growth_prompt_states
    SET last_action = p_event, last_action_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE user_id = p_user_id AND prompt = p_prompt
    RETURNING shown_count INTO v_count;
  RETURN jsonb_build_object('recorded', v_count IS NOT NULL, 'shown_count', COALESCE(v_count, 0));
END;
$function$;

CREATE TABLE billing.image_plaza_share_rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES app_core.users(id),
  work_id uuid NOT NULL UNIQUE, attempt_id uuid NOT NULL, debit_ledger_id uuid NOT NULL UNIQUE, reward_ledger_id uuid,
  rebate_rate numeric NOT NULL, debit_credits numeric NOT NULL, reward_credits numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION billing.grant_bonus_credits(p_user_id uuid, p_amount numeric, p_reason text, p_source text, p_ref text, p_meta jsonb)
 RETURNS TABLE(o_ledger_id uuid) LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
CREATE TABLE media_plaza.image_plaza_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, status text NOT NULL, debit_ledger_id uuid,
  reference_artifact_id uuid, model_id text, prompt text, aspect_ratio text, resolution text, reasoning text,
  auto_optimize boolean, mode text, credits_charged numeric NOT NULL DEFAULT 10);
CREATE TABLE media_plaza.image_plaza_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), origin text NOT NULL, attempt_id uuid, width int, height int);
CREATE TABLE media_plaza.image_plaza_reference_assets (id uuid PRIMARY KEY, user_id uuid);
CREATE TABLE media_plaza.image_plaza_works (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, attempt_id uuid, artifact_id uuid UNIQUE,
  title text, model_id text, model_name text, width int, height int, tags text[], snapshot jsonb, deleted_at timestamptz);
SQL

# Production share function body, unchanged except CRLF -> LF.
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE FUNCTION billing.share_image_plaza_artifact(p_user_id uuid, p_artifact_id uuid, p_title text, p_model_name text, p_tags text[], p_rebate_rate numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_artifact media_plaza.image_plaza_artifacts%ROWTYPE;
  v_attempt media_plaza.image_plaza_attempts%ROWTYPE;
  v_work media_plaza.image_plaza_works%ROWTYPE;
  v_reward NUMERIC(14,1);
  v_reward_ledger UUID;
  v_grant RECORD;
BEGIN
  IF p_rebate_rate IS NULL OR p_rebate_rate < 0 OR p_rebate_rate > 1 THEN
    RAISE EXCEPTION 'invalid image plaza rebate rate' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_artifact FROM media_plaza.image_plaza_artifacts WHERE id = p_artifact_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'artifact not found' USING ERRCODE = 'P0002'; END IF;
  IF v_artifact.origin <> 'generated' OR v_artifact.attempt_id IS NULL THEN
    RAISE EXCEPTION 'artifact is not shareable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_attempt
  FROM media_plaza.image_plaza_attempts
  WHERE id = v_artifact.attempt_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_attempt.user_id <> p_user_id
     OR v_attempt.status <> 'ready'
     OR v_attempt.debit_ledger_id IS NULL THEN
    RAISE EXCEPTION 'artifact is not shareable' USING ERRCODE = '42501';
  END IF;
  IF v_attempt.reference_artifact_id IS NOT NULL THEN
    PERFORM 1
    FROM media_plaza.image_plaza_reference_assets AS reference
    WHERE reference.id = v_attempt.reference_artifact_id
      AND (
        reference.user_id = p_user_id
        OR EXISTS (
          SELECT 1
          FROM media_plaza.image_plaza_works AS source_work
          WHERE source_work.deleted_at IS NULL
            AND source_work.snapshot->>'reference_artifact_id' = reference.id::TEXT
        )
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reference artifact not accessible' USING ERRCODE = '42501';
    END IF;
  END IF;
  SELECT * INTO v_work FROM media_plaza.image_plaza_works WHERE artifact_id = p_artifact_id;
  IF FOUND THEN
    SELECT reward_credits INTO v_reward
    FROM billing.image_plaza_share_rewards
    WHERE work_id = v_work.id;
    RETURN jsonb_build_object(
      'work_id', v_work.id,
      'already_shared', true,
      'reward_credits', COALESCE(v_reward, 0)
    );
  END IF;

  INSERT INTO media_plaza.image_plaza_works(
    user_id, attempt_id, artifact_id, title, model_id, model_name, width, height, tags, snapshot
  ) VALUES (
    p_user_id, v_attempt.id, v_artifact.id, left(trim(p_title), 80),
    v_attempt.model_id, left(trim(p_model_name), 80),
    v_artifact.width, v_artifact.height, COALESCE(p_tags, '{}'),
    jsonb_build_object(
      'prompt', v_attempt.prompt,
      'model_id', v_attempt.model_id,
      'aspect_ratio', v_attempt.aspect_ratio,
      'resolution', v_attempt.resolution,
      'reasoning', v_attempt.reasoning,
      'auto_optimize', v_attempt.auto_optimize,
      'mode', v_attempt.mode,
      'reference_artifact_id', v_attempt.reference_artifact_id,
      'style', 'None'
    )
  ) RETURNING * INTO v_work;

  v_reward := round(v_attempt.credits_charged * p_rebate_rate, 1);
  IF v_reward > 0 THEN
    SELECT * INTO v_grant
    FROM billing.grant_bonus_credits(
      p_user_id,
      v_reward,
      'image_plaza_share_reward',
      'image_plaza_share_reward',
      v_work.id::TEXT,
      jsonb_build_object(
        'attempt_id', v_attempt.id,
        'debit_ledger_id', v_attempt.debit_ledger_id,
        'rebate_rate', p_rebate_rate
      )
    );
    v_reward_ledger := v_grant.o_ledger_id;
  END IF;

  INSERT INTO billing.image_plaza_share_rewards(
    user_id, work_id, attempt_id, debit_ledger_id, reward_ledger_id,
    rebate_rate, debit_credits, reward_credits
  ) VALUES (
    p_user_id, v_work.id, v_attempt.id, v_attempt.debit_ledger_id, v_reward_ledger,
    p_rebate_rate, v_attempt.credits_charged, v_reward
  );
  INSERT INTO app_core.miniapp_user_settings(user_id, image_plaza_first_share_completed_at)
  VALUES (p_user_id, now())
  ON CONFLICT (user_id) DO UPDATE
  SET image_plaza_first_share_completed_at = COALESCE(
        app_core.miniapp_user_settings.image_plaza_first_share_completed_at,
        EXCLUDED.image_plaza_first_share_completed_at
      ),
      updated_at = now();
  RETURN jsonb_build_object(
    'work_id', v_work.id,
    'already_shared', false,
    'reward_credits', v_reward
  );
END;
$function$;
CREATE FUNCTION test_fixture.make_shareable(p_user uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_attempt uuid; v_artifact uuid;
BEGIN
  INSERT INTO media_plaza.image_plaza_attempts (user_id, status, debit_ledger_id, credits_charged)
    VALUES (p_user, 'ready', gen_random_uuid(), 20) RETURNING id INTO v_attempt;
  INSERT INTO media_plaza.image_plaza_artifacts (origin, attempt_id, width, height)
    VALUES ('generated', v_attempt, 512, 512) RETURNING id INTO v_artifact;
  RETURN v_artifact;
END $$;
SQL

# Data: 40 users, 36 with settings; marks, growth states and shares spread across them.
"${admin_psql[@]}" >/dev/null <<'SQL'
INSERT INTO app_core.users (tg_id) SELECT (1000 + g)::text FROM generate_series(1, 40) g;
INSERT INTO app_core.miniapp_user_settings (user_id, tg_first_name, characters_last_seen_at, vip_entry_seen_at)
SELECT u.id, 'u' || u.tg_id,
  CASE WHEN u.tg_id::int % 3 = 0 THEN now() - ((u.tg_id::int % 9) || ' days')::interval END,
  CASE WHEN u.tg_id::int % 4 = 0 THEN now() - ((u.tg_id::int % 11) || ' days')::interval END
FROM app_core.users u WHERE u.tg_id::int <= 1036;
UPDATE app_core.miniapp_user_settings SET pref_show_options = false WHERE user_id IN (SELECT id FROM app_core.users WHERE tg_id::int % 5 = 0);
INSERT INTO miniapp_features.growth_prompt_states (user_id, prompt, shown_count, first_shown_at, last_shown_at, last_action, last_action_at)
SELECT u.id, p, 1 + (u.tg_id::int % 3), now() - interval '5 days', now() - ((u.tg_id::int % 4) || ' hours')::interval,
  CASE WHEN u.tg_id::int % 2 = 0 THEN 'dismissed' END, CASE WHEN u.tg_id::int % 2 = 0 THEN now() - interval '1 hour' END
FROM app_core.users u CROSS JOIN unnest(ARRAY['community', 'vip']) p WHERE u.tg_id::int % 7 <> 0;
-- Old-world first shares for users 1001..1003.
SELECT billing.share_image_plaza_artifact(u.id, test_fixture.make_shareable(u.id), 't', 'm', NULL, 0.5)
FROM app_core.users u WHERE u.tg_id IN ('1001', '1002', '1003');
CREATE TABLE test_fixture.growth_before AS SELECT * FROM miniapp_features.growth_prompt_states;
CREATE TABLE test_fixture.settings_before AS
  SELECT user_id, vip_entry_seen_at, characters_last_seen_at, image_plaza_first_share_completed_at FROM app_core.miniapp_user_settings;
CREATE TABLE test_fixture.r (k text PRIMARY KEY, j jsonb);
SQL

"${admin_psql[@]}" >/dev/null < "$expand"
"${admin_psql[@]}" >/dev/null < "$expand"

"${admin_psql[@]}" <<'SQL'
\set QUIET on
DO $after_expand$
BEGIN
  -- Compat view returns exactly the old rows.
  IF EXISTS (SELECT user_id, prompt, shown_count, first_shown_at, last_shown_at, last_action, last_action_at FROM test_fixture.growth_before
             EXCEPT SELECT user_id, prompt, shown_count, first_shown_at, last_shown_at, last_action, last_action_at FROM miniapp_features.growth_prompt_states)
     OR (SELECT count(*) FROM miniapp_features.growth_prompt_states) <> (SELECT count(*) FROM test_fixture.growth_before) THEN
    RAISE EXCEPTION 'growth states changed';
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid = 'miniapp_features.growth_prompt_states'::regclass) <> 'v' THEN
    RAISE EXCEPTION 'growth_prompt_states should be a compat view';
  END IF;
  IF EXISTS (SELECT 1 FROM test_fixture.settings_before b
             LEFT JOIN miniapp_features.user_marks v ON v.user_id = b.user_id AND v.mark_key = 'vip_entry.seen'
             LEFT JOIN miniapp_features.user_marks c ON c.user_id = b.user_id AND c.mark_key = 'characters_latest.seen'
             WHERE v.first_at IS DISTINCT FROM b.vip_entry_seen_at OR c.last_at IS DISTINCT FROM b.characters_last_seen_at) THEN
    RAISE EXCEPTION 'settings marks not backfilled exactly';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'app_core' AND table_name = 'miniapp_user_settings'
             AND column_name LIKE '%full_rules_remaining')
     OR to_regprocedure('app_core.claim_instruction_slot_modes(uuid)') IS NOT NULL
     OR to_regprocedure('app_core.instruction_slot_claim_ok()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_apply_instruction_slot_preference_window') THEN
    RAISE EXCEPTION 'legacy slot counters survived';
  END IF;
  IF to_regclass('billing.image_plaza_share_rewards_user_idx') IS NULL THEN RAISE EXCEPTION 'reward user index missing'; END IF;
  IF has_table_privilege('anon', 'miniapp_features.user_marks', 'SELECT')
     OR has_function_privilege('anon', 'miniapp_features.touch_user_mark(uuid,text,timestamptz)', 'EXECUTE')
     OR NOT has_table_privilege('service_role', 'miniapp_features.user_marks', 'SELECT')
     OR has_table_privilege('service_role', 'miniapp_features.user_marks', 'INSERT')
     OR NOT has_function_privilege('service_role', 'miniapp_features.touch_user_mark(uuid,text,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'user_marks grants wrong';
  END IF;
END $after_expand$;

-- Growth prompt semantics on the new table (same cap / interval / action rules).
CREATE FUNCTION test_fixture.uid(t text) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM app_core.users WHERE tg_id = t $$;
INSERT INTO test_fixture.r VALUES
  ('new_shown', miniapp_features.record_growth_prompt_event(test_fixture.uid('1008'), 'vip', 'shown', 3, 86400)),
  ('new_again', miniapp_features.record_growth_prompt_event(test_fixture.uid('1008'), 'vip', 'shown', 3, 86400)),
  ('capped', miniapp_features.record_growth_prompt_event(test_fixture.uid('1002'), 'community', 'shown', 1, 0)),
  ('interval_ok', miniapp_features.record_growth_prompt_event(test_fixture.uid('1005'), 'community', 'shown', 9, 1800)),
  ('accept', miniapp_features.record_growth_prompt_event(test_fixture.uid('1008'), 'vip', 'accepted', 3, 0)),
  ('accept_missing', miniapp_features.record_growth_prompt_event(test_fixture.uid('1015'), 'community', 'dismissed', 3, 0));
DO $growth$
DECLARE r jsonb;
BEGIN
  IF (SELECT j FROM test_fixture.r WHERE k = 'new_shown') <> '{"recorded": true, "shown_count": 1}'
     OR (SELECT j FROM test_fixture.r WHERE k = 'new_again') <> '{"recorded": false, "shown_count": 1}'
     OR (SELECT j->>'recorded' FROM test_fixture.r WHERE k = 'capped') <> 'false'
     OR (SELECT j FROM test_fixture.r WHERE k = 'interval_ok') <> jsonb_build_object('recorded', true, 'shown_count',
           (SELECT shown_count + 1 FROM test_fixture.growth_before WHERE user_id = test_fixture.uid('1005') AND prompt = 'community'))
     OR (SELECT j FROM test_fixture.r WHERE k = 'accept') <> '{"recorded": true, "shown_count": 1}'
     OR (SELECT j FROM test_fixture.r WHERE k = 'accept_missing') <> '{"recorded": false, "shown_count": 0}' THEN
    RAISE EXCEPTION 'growth prompt semantics changed: %', (SELECT jsonb_object_agg(k, j) FROM test_fixture.r);
  END IF;
  IF (SELECT last_action FROM miniapp_features.growth_prompt_states WHERE user_id = test_fixture.uid('1008') AND prompt = 'vip') <> 'accepted' THEN
    RAISE EXCEPTION 'action not visible through compat view';
  END IF;
END $growth$;

-- touch_user_mark: counts, first_at fixed, last_at moves.
SELECT * FROM miniapp_features.touch_user_mark(test_fixture.uid('1009'), 'demo.seen', '2026-01-01T00:00:00Z') \g /dev/null
SELECT count AS c, first_at AS f, last_at AS l FROM miniapp_features.touch_user_mark(test_fixture.uid('1009'), 'demo.seen', '2026-02-01T00:00:00Z') \gset t_
SELECT (:t_c = 2 AND :'t_f'::timestamptz = '2026-01-01T00:00:00Z' AND :'t_l'::timestamptz = '2026-02-01T00:00:00Z') AS touch_ok \gset
\if :touch_ok
\else
  \echo 'touch_user_mark semantics wrong'
  SELECT 1 / 0;
\endif
DO $bad_key$ BEGIN
  BEGIN PERFORM miniapp_features.touch_user_mark(test_fixture.uid('1009'), 'NoDot', NULL); RAISE EXCEPTION 'bad key accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $bad_key$;

-- Release window, old backend -> new table.
UPDATE app_core.miniapp_user_settings SET vip_entry_seen_at = '2026-03-01T00:00:00Z', updated_at = now()
  WHERE user_id = test_fixture.uid('1001') AND vip_entry_seen_at IS NULL;
INSERT INTO app_core.miniapp_user_settings (user_id, vip_entry_seen_at) VALUES (test_fixture.uid('1037'), '2026-03-02T00:00:00Z');
UPDATE app_core.miniapp_user_settings SET characters_last_seen_at = '2026-03-03T00:00:00Z' WHERE user_id = test_fixture.uid('1003');
SELECT * FROM app_core.update_instruction_slot_preferences(test_fixture.uid('1005'), true, false, NULL) \g /dev/null
-- Release window, new backend -> old columns.
SELECT * FROM miniapp_features.touch_user_mark(test_fixture.uid('1002'), 'vip_entry.seen', '2026-03-04T00:00:00Z') \g /dev/null
SELECT * FROM miniapp_features.touch_user_mark(test_fixture.uid('1038'), 'vip_entry.seen', '2026-03-05T00:00:00Z') \g /dev/null
SELECT * FROM miniapp_features.touch_user_mark(test_fixture.uid('1006'), 'characters_latest.seen', '2026-03-06T00:00:00Z') \g /dev/null
SELECT * FROM miniapp_features.touch_user_mark(test_fixture.uid('1004'), 'vip_entry.seen', '2026-03-07T00:00:00Z') \g /dev/null
DO $window$
DECLARE
  m record;
BEGIN
  SELECT * INTO m FROM miniapp_features.user_marks WHERE user_id = test_fixture.uid('1001') AND mark_key = 'vip_entry.seen';
  IF m.first_at IS DISTINCT FROM '2026-03-01T00:00:00Z' OR m.count <> 1 THEN RAISE EXCEPTION 'old vip write not synced: %', row_to_json(m); END IF;
  SELECT * INTO m FROM miniapp_features.user_marks WHERE user_id = test_fixture.uid('1037') AND mark_key = 'vip_entry.seen';
  IF m.first_at IS DISTINCT FROM '2026-03-02T00:00:00Z' THEN RAISE EXCEPTION 'old vip insert not synced'; END IF;
  SELECT * INTO m FROM miniapp_features.user_marks WHERE user_id = test_fixture.uid('1003') AND mark_key = 'characters_latest.seen';
  IF m.last_at IS DISTINCT FROM '2026-03-03T00:00:00Z' THEN RAISE EXCEPTION 'old characters write not synced'; END IF;
  IF (SELECT vip_entry_seen_at FROM app_core.miniapp_user_settings WHERE user_id = test_fixture.uid('1002')) IS DISTINCT FROM '2026-03-04T00:00:00Z'
     OR (SELECT vip_entry_seen_at FROM app_core.miniapp_user_settings WHERE user_id = test_fixture.uid('1038')) IS DISTINCT FROM '2026-03-05T00:00:00Z'
     OR (SELECT characters_last_seen_at FROM app_core.miniapp_user_settings WHERE user_id = test_fixture.uid('1006')) IS DISTINCT FROM '2026-03-06T00:00:00Z' THEN
    RAISE EXCEPTION 'new writes not mirrored to settings';
  END IF;
  -- 1004 had seen the VIP entry before: the old first-seen time stays on both sides.
  IF (SELECT vip_entry_seen_at FROM app_core.miniapp_user_settings WHERE user_id = test_fixture.uid('1004'))
       IS DISTINCT FROM (SELECT vip_entry_seen_at FROM test_fixture.settings_before WHERE user_id = test_fixture.uid('1004'))
     OR (SELECT first_at FROM miniapp_features.user_marks WHERE user_id = test_fixture.uid('1004') AND mark_key = 'vip_entry.seen')
       IS DISTINCT FROM (SELECT vip_entry_seen_at FROM test_fixture.settings_before WHERE user_id = test_fixture.uid('1004')) THEN
    RAISE EXCEPTION 'first seen time overwritten';
  END IF;
  IF (SELECT count FROM miniapp_features.user_marks WHERE user_id = test_fixture.uid('1002') AND mark_key = 'vip_entry.seen') <> 1
     OR (SELECT count FROM miniapp_features.user_marks WHERE user_id = test_fixture.uid('1004') AND mark_key = 'vip_entry.seen') <> 2 THEN
    RAISE EXCEPTION 'sync double counted';
  END IF;
  IF (SELECT pref_show_status FROM app_core.miniapp_user_settings WHERE user_id = test_fixture.uid('1005')) THEN
    RAISE EXCEPTION 'slot preference update broken';
  END IF;
END $window$;
SQL
echo 'OK: expand'

# Old-world share during the window still writes settings (contract removes that).
"${admin_psql[@]}" -c "SELECT billing.share_image_plaza_artifact(test_fixture.uid('1010'), test_fixture.make_shareable(test_fixture.uid('1010')), 't', 'm', NULL, 0)" >/dev/null

# Race leftover: a value that only reached settings (sync trigger bypassed).
"${admin_psql[@]}" >/dev/null <<'SQL'
ALTER TABLE app_core.miniapp_user_settings DISABLE TRIGGER settings_sync_marks;
UPDATE app_core.miniapp_user_settings SET vip_entry_seen_at = '2026-04-01T00:00:00Z' WHERE user_id = test_fixture.uid('1005');
UPDATE app_core.miniapp_user_settings SET characters_last_seen_at = '2026-04-02T00:00:00Z' WHERE user_id = test_fixture.uid('1009');
ALTER TABLE app_core.miniapp_user_settings ENABLE TRIGGER settings_sync_marks;
CREATE TABLE test_fixture.first_share_before AS
  SELECT user_id FROM app_core.miniapp_user_settings WHERE image_plaza_first_share_completed_at IS NOT NULL;
SQL

# A first-share time without a reward record (hand-edited test data) blocks the contract; the pre-step clears it.
"${admin_psql[@]}" -c "UPDATE app_core.miniapp_user_settings SET image_plaza_first_share_completed_at = now() WHERE user_id = test_fixture.uid('1012')" >/dev/null
if "${admin_psql[@]}" >/dev/null 2>&1 < "$contract"; then echo 'contract ignored an orphan first share' >&2; exit 1; fi
"${admin_psql[@]}" >/dev/null < "$clear_orphan"
"${admin_psql[@]}" >/dev/null < "$clear_orphan"
[[ "$("${admin_psql[@]}" -At -c "SELECT count(*) FROM app_core.miniapp_user_settings WHERE image_plaza_first_share_completed_at IS NOT NULL")" == 4 ]] ||
  { echo 'orphan pre-step cleared the wrong rows' >&2; exit 1; }

# Contract refuses when someone else changed the share function's settings write.
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE TABLE test_fixture.share_def AS
  SELECT pg_get_functiondef('billing.share_image_plaza_artifact(uuid,uuid,text,text,text[],numeric)'::regprocedure) AS def;
DO $tamper$ BEGIN
  EXECUTE replace((SELECT def FROM test_fixture.share_def), 'updated_at = now();', 'updated_at = clock_timestamp();');
END $tamper$;
SQL
if "${admin_psql[@]}" >/dev/null 2>&1 < "$contract"; then echo 'contract rewrote a changed share function' >&2; exit 1; fi
"${admin_psql[@]}" -c "DO \$r\$ BEGIN EXECUTE (SELECT def FROM test_fixture.share_def); END \$r\$" >/dev/null

"${admin_psql[@]}" >/dev/null < "$contract"
"${admin_psql[@]}" >/dev/null < "$contract"

"${admin_psql[@]}" <<'SQL'
\set QUIET on
INSERT INTO test_fixture.r VALUES
  ('share_new', billing.share_image_plaza_artifact(test_fixture.uid('1011'), test_fixture.make_shareable(test_fixture.uid('1011')), 't', 'm', NULL, 0.5));
INSERT INTO test_fixture.r VALUES
  ('share_again', billing.share_image_plaza_artifact(test_fixture.uid('1011'),
     (SELECT artifact_id FROM media_plaza.image_plaza_works WHERE id = ((SELECT j->>'work_id' FROM test_fixture.r WHERE k = 'share_new'))::uuid), 't', 'm', NULL, 0.5));
DO $after_contract$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'app_core' AND table_name = 'miniapp_user_settings'
             AND column_name IN ('vip_entry_seen_at', 'characters_last_seen_at', 'image_plaza_first_share_completed_at'))
     OR to_regclass('miniapp_features.growth_prompt_states') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('settings_sync_marks', 'user_marks_sync_settings'))
     OR to_regprocedure('app_core.tf_sync_settings_marks()') IS NOT NULL THEN
    RAISE EXCEPTION 'contract left old objects';
  END IF;
  IF (SELECT first_at FROM miniapp_features.user_marks WHERE user_id = test_fixture.uid('1005') AND mark_key = 'vip_entry.seen')
       IS DISTINCT FROM '2026-04-01T00:00:00Z'
     OR (SELECT last_at FROM miniapp_features.user_marks WHERE user_id = test_fixture.uid('1009') AND mark_key = 'characters_latest.seen')
       IS DISTINCT FROM '2026-04-02T00:00:00Z' THEN
    RAISE EXCEPTION 'race leftovers not reconciled';
  END IF;
  -- First share derivation equals the old column (users 1001..1003 + 1010 shared before contract).
  IF EXISTS (SELECT user_id FROM test_fixture.first_share_before EXCEPT SELECT DISTINCT user_id FROM billing.image_plaza_share_rewards WHERE user_id <> test_fixture.uid('1011'))
     OR EXISTS (SELECT DISTINCT user_id FROM billing.image_plaza_share_rewards WHERE user_id <> test_fixture.uid('1011') EXCEPT SELECT user_id FROM test_fixture.first_share_before)
     OR (SELECT count(*) FROM test_fixture.first_share_before) <> 4 THEN
    RAISE EXCEPTION 'first share derivation differs from old column';
  END IF;
  IF (SELECT j->>'already_shared' FROM test_fixture.r WHERE k = 'share_new') <> 'false'
     OR (SELECT (j->>'reward_credits')::numeric FROM test_fixture.r WHERE k = 'share_new') <> 10
     OR (SELECT j->>'already_shared' FROM test_fixture.r WHERE k = 'share_again') <> 'true'
     OR NOT EXISTS (SELECT 1 FROM billing.image_plaza_share_rewards WHERE user_id = test_fixture.uid('1011')) THEN
    RAISE EXCEPTION 'share broken after contract: %', (SELECT jsonb_object_agg(k, j) FROM test_fixture.r WHERE k LIKE 'share%');
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'billing.share_image_plaza_artifact(uuid,uuid,text,text,text[],numeric)'::regprocedure) ~ 'miniapp_user_settings'
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'billing.share_image_plaza_artifact(uuid,uuid,text,text,text[],numeric)'::regprocedure) THEN
    RAISE EXCEPTION 'share function not rewritten as expected';
  END IF;
END $after_contract$;
-- New backend paths still work after contract.
SELECT * FROM miniapp_features.touch_user_mark(test_fixture.uid('1022'), 'vip_entry.seen', NULL) \g /dev/null
SELECT miniapp_features.record_growth_prompt_event(test_fixture.uid('1022'), 'community', 'shown', 2, 0) \g /dev/null
DO $post$ BEGIN
  IF (SELECT count(*) FROM miniapp_features.user_marks WHERE user_id = test_fixture.uid('1022')) <> 2 THEN
    RAISE EXCEPTION 'marks broken after contract'; END IF;
END $post$;
SQL
echo 'OK: 20261117_db_reorg_p3b1_user_marks.sql + _contract'
