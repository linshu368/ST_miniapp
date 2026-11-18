#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261118_db_reorg_p3d_flatten_config_validator.sql as a NON-superuser:
# - the TEST pre-step 20261118_db_reorg_p3d_align_test_validator_chain.sql builds the production 16-layer chain (bodies
#   generated from the historical migrations by production md5 + the video catalog branch) on an empty/TEST-shaped
#   chain, is a no-op on the production shape, and refuses to rebuild outside TEST; called helper validators are probe
#   stubs that name themselves when given {"__fail":true}, so a wrong dispatch shows up as a different outcome;
# - guard refuses a changed layer and an extra layer; the in-migration self-check refuses a flattened branch that
#   differs (tampered copy of the migration); refused runs leave the chain untouched;
# - applied from a session that already cached a plan calling the validator, the caller keeps working;
# - afterwards every managed key gives exactly the old outcome (ok / SQLSTATE:message) on a key x value x text_value
#   matrix plus stored config rows; retired / unregistered keys are rejected as not managed; the old chain and the two
#   retired-only helpers are gone; only the owner can execute; re-running is a no-op.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261118_db_reorg_p3d_flatten_config_validator.sql"
align="$task_root/packages/shared/migrations/20261118_db_reorg_p3d_align_test_validator_chain.sql"
task_container="st-db-reorg-p3d-${RANDOM}-$$"
work_dir="$(mktemp -d)"
trap 'docker rm -f "$task_container" >/dev/null 2>&1 || true; rm -rf "$work_dir"' EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
super_psql=(docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1)
admin_psql=(docker exec -i "$task_container" psql -X -q -U app_admin -d postgres -v ON_ERROR_STOP=1)

expect_fail() { # label, expected error substring; SQL on stdin
  local out
  if out=$("${admin_psql[@]}" 2>&1); then
    echo "FAIL: $1 should have been refused"; exit 1
  fi
  if [[ "$out" != *"$2"* ]]; then
    echo "FAIL: $1 refused with an unexpected error:"; echo "$out"; exit 1
  fi
  echo "ok: $1 refused"
}
assert_chain_intact() {
  "${admin_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'admin'::regnamespace AND proname LIKE 'validate\_managed\_config\_value%') <> 16
     OR to_regprocedure('admin.validate_managed_config_value_legacy(text,jsonb,text)') IS NOT NULL
     OR to_regprocedure('admin.validate_payment_plan_list(jsonb)') IS NOT NULL
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_proc WHERE oid = 'admin.validate_managed_config_value(text,jsonb,text)'::regprocedure)
        <> 'c637e78820a51c60ac0b6b8749681997' THEN
    RAISE EXCEPTION 'assert: refused run left changes behind';
  END IF;
END $$;
SQL
}

"${super_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE;
GRANT CREATE, CONNECT ON DATABASE postgres TO app_admin;
SQL


"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA admin; CREATE SCHEMA app_core; CREATE SCHEMA test_fixture;
GRANT USAGE ON SCHEMA admin TO anon, authenticated, service_role;

CREATE TABLE admin.environment_config (id integer PRIMARY KEY, environment text NOT NULL);
INSERT INTO admin.environment_config VALUES (1, 'test');
CREATE FUNCTION admin.current_environment() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT environment FROM admin.environment_config WHERE id = 1 $$;

CREATE TABLE admin.managed_config_keys (
  config_key text PRIMARY KEY, managed_via text NOT NULL, retired_at timestamptz, note text,
  created_at timestamptz NOT NULL DEFAULT now());
-- Production registry (11-18): all operations_config except the text post-process pointer; 7 retired.
INSERT INTO admin.managed_config_keys (config_key, managed_via, retired_at)
SELECT k, CASE WHEN k = 'miniapp_text_postprocess_config' THEN 'text_postprocess' ELSE 'operations_config' END,
       CASE WHEN k IN ('image_plaza_tags_feature_enabled', 'lobby_pinned_characters', 'media_feature_free_trial_limit',
                       'miniapp_daily_checkin_bonus_credits', 'miniapp_payment_prompt_dialog_config',
                       'miniapp_recharge_page_config', 'system_fallback_character_id') THEN now() END
FROM unnest(ARRAY['choice_rules', 'creator_character_review_prompt', 'drive_mode_options', 'feature_free_trial_limits',
  'free_zone_config', 'image_default_art_style', 'image_description_failed_hint', 'image_description_system_prompt',
  'image_failed_unknown_hint', 'image_generation_credits', 'image_generation_enabled', 'image_generation_failed_hint',
  'image_height', 'image_max_output_bytes', 'image_max_prompt_chars', 'image_plaza_enabled', 'image_plaza_model_catalog',
  'image_plaza_share_tip', 'image_plaza_tags', 'image_plaza_tags_feature_enabled', 'image_price_label',
  'image_prompt_over_limit_hint', 'image_prompt_policy', 'image_text_model_config', 'image_width', 'llm_model_catalog',
  'llm_pricing_config', 'llm_provider_routing_config', 'lobby_pinned_characters', 'lobby_ranking_params',
  'media_feature_free_trial_limit', 'memory_rules', 'miniapp_character_free_chat_quota_limit',
  'miniapp_checkin_new_user_credits', 'miniapp_checkin_veteran_credits', 'miniapp_daily_checkin_bonus_credits',
  'miniapp_free_quota_exhausted_dialog_config', 'miniapp_invite_center_config', 'miniapp_invite_entry_enabled',
  'miniapp_invite_reward_rules', 'miniapp_new_user_signup_bonus_credits', 'miniapp_payment_plans',
  'miniapp_payment_prompt_dialog_config', 'miniapp_recharge_page_config', 'miniapp_text_postprocess_config',
  'pref_word_count_tiers', 'reply_style_options', 'status_rules', 'story_memory_config', 'story_memory_prompt',
  'system_fallback_character_id', 'system_instructions', 'vip_checkin_bonus_config', 'vip_plans_config',
  'vip_purchase_enabled', 'vip_reminders_enabled', 'vip_text_discount_rate', 'image_plaza_video_model_catalog']) AS k;
CREATE FUNCTION admin.is_managed_config_key(p_config_key text) RETURNS boolean LANGUAGE sql STABLE
  SET search_path TO 'pg_catalog' AS $$
    SELECT CASE WHEN p_config_key IS NULL THEN NULL ELSE EXISTS (
      SELECT 1 FROM admin.managed_config_keys m
      WHERE m.config_key = p_config_key AND m.managed_via = 'operations_config' AND m.retired_at IS NULL
    ) END
  $$;

-- Probe stubs for the helper validators the chain calls: {"__fail":true} makes them name themselves.
DO $stubs$
DECLARE
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['validate_llm_provider_routing_config', 'validate_image_plaza_model_catalog',
    'validate_image_plaza_share_tip', 'validate_image_plaza_tags', 'validate_image_text_model_config',
    'validate_lobby_pinned_characters', 'validate_payment_prompt_dialog_config', 'validate_invite_reward_rules',
    'validate_invite_center_config', 'validate_vip_plans_config', 'validate_vip_text_discount_rate',
    'validate_vip_checkin_bonus_config', 'validate_feature_free_trial_limits', 'validate_lobby_ranking_params',
    'validate_model_catalog_core', 'validate_model_catalog_prd', 'validate_fixed_llm_deduction_config',
    'validate_recharge_page_config', 'validate_free_quota_exhausted_dialog_config',
    'validate_image_plaza_video_model_catalog'] LOOP
    EXECUTE format($f$CREATE FUNCTION admin.%I(p_value jsonb) RETURNS void LANGUAGE plpgsql STABLE AS $b$
      BEGIN
        IF jsonb_typeof(p_value) = 'object' AND p_value ? '__fail' THEN
          RAISE EXCEPTION 'stub %s rejected' USING ERRCODE = '22023';
        END IF;
      END $b$$f$, v_name, v_name);
  END LOOP;
END
$stubs$;
CREATE FUNCTION admin.validate_image_generation_config_value(p_key text, p_value jsonb) RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF jsonb_typeof(p_value) = 'object' AND p_value ? '__fail' THEN
    RAISE EXCEPTION 'stub validate_image_generation_config_value rejected %', p_key USING ERRCODE = '22023';
  END IF;
END $$;

-- Stored config the in-migration self-check also replays (synthetic values).
CREATE TABLE admin.config_drafts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment text NOT NULL DEFAULT 'test',
  config_key text NOT NULL, value jsonb, text_value text, status text NOT NULL DEFAULT 'draft');
CREATE TABLE admin.config_releases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment text NOT NULL DEFAULT 'test',
  config_key text NOT NULL, value jsonb, text_value text);
CREATE TABLE app_core.runtime_config (key text PRIMARY KEY, value jsonb, text_value text);
INSERT INTO admin.config_drafts (config_key, value, text_value) VALUES
  ('lobby_ranking_params', '{"rotation":{"enabled":true,"interval_hours":24,"max_repeat":3,"exploration_count":1,"rollout_percent":50}}', NULL),
  ('system_instructions', NULL, '{{CHOICE_RULES}}{{STATUS_RULES}}{{MEMORY_RULES}}{{WORD_COUNT}}{{USER_CUSTOM_INSTRUCTIONS}}'),
  ('lobby_pinned_characters', '{"fixed_character_id":"not-a-uuid"}', NULL);
INSERT INTO admin.config_releases (config_key, value, text_value) VALUES
  ('miniapp_payment_plans', '{"plans":[{"id":"p1","price_cents":100,"credits_amount":10,"bonus_credits":0,"variant":"entry"}],"payment_channels":{"alipay_enabled":true,"wxpay_enabled":true,"default_payment_type":"wxpay"}}', NULL),
  ('miniapp_payment_plans', '[{"id":"p1","price_cents":100,"credits_amount":10,"bonus_credits":0,"variant":"premium"}]', NULL),
  ('story_memory_prompt', NULL, '记住剧情');
INSERT INTO app_core.runtime_config VALUES
  ('miniapp_text_postprocess_config', '{"version":3}', NULL),
  ('system_fallback_character_id', '"00000000-0000-4000-8000-000000000001"', NULL),
  ('drive_mode_options', '{"modes":[{"id":"a"}],"default_mode_id":"a"}', NULL);

-- A caller like admin.save_config_draft (SECURITY DEFINER, plan cached per session).
CREATE FUNCTION test_fixture.save_draft(p_key text, p_value jsonb, p_text text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM admin.validate_managed_config_value(p_key, p_value, p_text);
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || ':' || SQLERRM;
END $$;

-- Outcome of the current validator for a battery: every registered key + unregistered keys x values x text_value.
CREATE FUNCTION test_fixture.outcomes() RETURNS TABLE(config_key text, value jsonb, text_value text, outcome text)
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT k.k AS config_key, v.v AS value, t.t AS text_value
    FROM (SELECT m.config_key FROM admin.managed_config_keys m
          UNION SELECT unnest(ARRAY['__not_registered__', 'image_advanced_width', NULL])) AS k(k)
    CROSS JOIN (VALUES (NULL::jsonb), ('null'), ('true'), ('7'), ('-2'), ('2.5'), ('"x"'), ('[]'),
                       ('[{"id":"p","price_cents":1,"credits_amount":1,"bonus_credits":0,"variant":"standard"}]'),
                       ('{}'), ('{"__fail":true}'), ('{"rotation":{"enabled":true}}'),
                       ('{"fixed_character_id":"bad"}'),
                       ('{"on_first_two_turns":"a","on_later_turns":"b","off":"c"}')) AS v(v)
    CROSS JOIN (VALUES (NULL::text), ('  '), ('{{CHOICE_RULES}}{{STATUS_RULES}}{{MEMORY_RULES}}{{WORD_COUNT}}{{USER_CUSTOM_INSTRUCTIONS}}')) AS t(t)
  LOOP
    config_key := r.config_key; value := r.value; text_value := r.text_value;
    outcome := test_fixture.save_draft(r.config_key, r.value, r.text_value);
    RETURN NEXT;
  END LOOP;
END $$;
SQL
"${admin_psql[@]}" >/dev/null <"$align"
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE TABLE test_fixture.chain_md5 AS
SELECT oid::regprocedure::text AS fn, md5(prosrc) AS md5sum FROM pg_proc
WHERE pronamespace = 'admin'::regnamespace AND proname LIKE 'validate\_managed\_config\_value%';
DO $$ BEGIN
  IF (SELECT count(*) FROM test_fixture.chain_md5) <> 16
     OR (SELECT md5(replace(prosrc, E'\r', '')) FROM pg_proc WHERE oid = 'admin.validate_managed_config_value(text,jsonb,text)'::regprocedure)
        <> 'c637e78820a51c60ac0b6b8749681997' THEN
    RAISE EXCEPTION 'assert: align pre-step did not build the production chain';
  END IF;
END $$;
SQL
echo "ok: align pre-step builds the production 16-layer chain on TEST (empty chain)"

# Align pre-step: no-op on the production shape; refuses to rebuild outside TEST; rebuilds a TEST-shaped chain.
"${admin_psql[@]}" >/dev/null <"$align"
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
  IF EXISTS (SELECT oid::regprocedure::text, md5(prosrc) FROM pg_proc
             WHERE pronamespace = 'admin'::regnamespace AND proname LIKE 'validate\_managed\_config\_value%'
             EXCEPT SELECT fn, md5sum FROM test_fixture.chain_md5) THEN
    RAISE EXCEPTION 'assert: align changed the production-shaped chain';
  END IF;
END $$;
-- TEST shape: an extra wrapper layer and two layers swapped (bodies under each other's names).
CREATE FUNCTION admin.validate_managed_config_value_before_media_plaza_video(p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL)
  RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM admin.validate_managed_config_value_before_drive_mode(p_config_key, p_value, p_text_value); END $$;
CREATE TABLE test_fixture.swap AS SELECT
  pg_get_functiondef('admin.validate_managed_config_value_before_image_plaza(text,jsonb,text)'::regprocedure) AS a,
  pg_get_functiondef('admin.validate_managed_config_value_before_instruction_slots(text,jsonb,text)'::regprocedure) AS b;
DO $$ BEGIN
  EXECUTE replace((SELECT a FROM test_fixture.swap), 'validate_managed_config_value_before_image_plaza(', 'validate_managed_config_value_before_instruction_slots(');
END $$;
UPDATE admin.environment_config SET environment = 'production';
SQL
expect_fail "align outside TEST on a differing chain" "refusing to rebuild" <"$align"
"${admin_psql[@]}" >/dev/null <<'SQL'
UPDATE admin.environment_config SET environment = 'test';
SQL
"${admin_psql[@]}" >/dev/null <"$align"
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
  IF to_regprocedure('admin.validate_managed_config_value_before_media_plaza_video(text,jsonb,text)') IS NOT NULL
     OR EXISTS (SELECT fn, md5sum FROM test_fixture.chain_md5
                EXCEPT SELECT oid::regprocedure::text, md5(prosrc) FROM pg_proc
                WHERE pronamespace = 'admin'::regnamespace AND proname LIKE 'validate\_managed\_config\_value%') THEN
    RAISE EXCEPTION 'assert: align did not restore the production chain from the TEST shape';
  END IF;
END $$;
SQL
echo "ok: align is a no-op on the production shape, refuses outside TEST, rebuilds a TEST-shaped chain"

"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE TABLE test_fixture.baseline AS SELECT * FROM test_fixture.outcomes();
SQL


# Guards ------------------------------------------------------------------------------------------------------------
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE TABLE test_fixture.saved AS SELECT pg_get_functiondef('admin.validate_managed_config_value_before_vip_strategy(text,jsonb,text)'::regprocedure) AS def;
DO $$ BEGIN EXECUTE replace((SELECT def FROM test_fixture.saved), 'RETURN;', 'RETURN; -- changed'); END $$;
SQL
expect_fail "migration over a changed layer" "differ from the versions this migration was written against: validate_managed_config_value_before_vip_strategy" <"$migration"
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN EXECUTE (SELECT def FROM test_fixture.saved); END $$;
CREATE FUNCTION admin.validate_managed_config_value_before_extra(text, jsonb, text) RETURNS void LANGUAGE sql AS $$ SELECT $$;
SQL
expect_fail "migration with an extra layer" "unexpected extra admin.validate_managed_config_value* layers" <"$migration"
"${admin_psql[@]}" >/dev/null <<'SQL'
DROP FUNCTION admin.validate_managed_config_value_before_extra(text, jsonb, text);
SQL
assert_chain_intact

# Self-check: a flattened branch that differs from the chain must roll everything back.
grep -c "'free zone config requires a JSON object'" "$migration" | grep -qx 1
sed "s/'free zone config requires a JSON object'/'free zone config requires an object'/" "$migration" >"$work_dir/tampered.sql"
expect_fail "migration whose flattened branch differs" "flattened validator differs from the 16-layer chain" <"$work_dir/tampered.sql"
assert_chain_intact

# TEST stores some layers with the other line ending than production; the guard compares bodies without \r.
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$
DECLARE v_fn regprocedure; v_src text;
BEGIN
  v_fn := 'admin.validate_managed_config_value_before_image_plaza(text,jsonb,text)'::regprocedure;  -- LF -> CRLF
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_fn;
  EXECUTE replace(pg_get_functiondef(v_fn), v_src, replace(v_src, E'\n', E'\r\n'));
  v_fn := 'admin.validate_managed_config_value_before_payment_prompt(text,jsonb,text)'::regprocedure;  -- CRLF -> LF
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_fn;
  EXECUTE replace(pg_get_functiondef(v_fn), v_src, replace(v_src, E'\r', ''));
  IF position(E'\r' IN (SELECT prosrc FROM pg_proc WHERE oid = 'admin.validate_managed_config_value_before_image_plaza(text,jsonb,text)'::regprocedure)) = 0
     OR position(E'\r' IN (SELECT prosrc FROM pg_proc WHERE oid = v_fn)) > 0 THEN
    RAISE EXCEPTION 'assert: line endings not flipped';
  END IF;
END $$;
SQL

# Apply from a session that already cached a plan calling the validator --------------------------------------------
docker cp "$migration" "$task_container:/tmp/p3d.sql" >/dev/null
"${admin_psql[@]}" -At >"$work_dir/warm.txt" <<'SQL'
SELECT test_fixture.save_draft('free_zone_config', '{}', NULL);
\i /tmp/p3d.sql
SELECT test_fixture.save_draft('free_zone_config', '{}', NULL);
SELECT test_fixture.save_draft('lobby_pinned_characters', '{}', NULL);
SQL
if [[ "$(tr '\n' '|' <"$work_dir/warm.txt")" != 'ok|ok|22023:config key is not managed by admin: lobby_pinned_characters|' ]]; then
  echo "FAIL: caller in a warm session:"; cat "$work_dir/warm.txt"; exit 1
fi
echo "ok: migration applied; a caller with a cached plan keeps working in the same session"

"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$
DECLARE
  v_n integer;
  v_first text;
BEGIN
  -- Managed keys: identical outcome; everything else: not managed.
  SELECT count(*), min(format('%s %s %s: %s -> %s', b.config_key, b.value, b.text_value, b.outcome, a.outcome))
    INTO v_n, v_first
  FROM test_fixture.baseline b
  JOIN test_fixture.outcomes() a
    ON a.config_key IS NOT DISTINCT FROM b.config_key AND a.value IS NOT DISTINCT FROM b.value
   AND a.text_value IS NOT DISTINCT FROM b.text_value
  WHERE a.outcome IS DISTINCT FROM CASE WHEN admin.is_managed_config_key(b.config_key) IS TRUE THEN b.outcome
                                        ELSE '22023:config key is not managed by admin: ' || coalesce(b.config_key, '<NULL>') END;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'assert: % outcomes changed, e.g. %', v_n, v_first;
  END IF;
  IF (SELECT count(*) FROM test_fixture.baseline) < 2000 THEN
    RAISE EXCEPTION 'assert: battery too small';
  END IF;
  -- The probe stubs must actually be reached through the new dispatch.
  IF (SELECT count(DISTINCT outcome) FROM test_fixture.baseline WHERE outcome LIKE '22023:stub %') < 18 THEN
    RAISE EXCEPTION 'assert: battery did not reach the helper validators';
  END IF;

  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'admin'::regnamespace AND proname LIKE 'validate\_managed\_config\_value%') <> 1
     OR to_regprocedure('admin.validate_lobby_pinned_characters(jsonb)') IS NOT NULL
     OR to_regprocedure('admin.validate_payment_prompt_dialog_config(jsonb)') IS NOT NULL
     OR to_regprocedure('admin.validate_recharge_page_config(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'assert: old chain / retired helpers not dropped, or a kept helper dropped';
  END IF;
  IF has_function_privilege('anon', 'admin.validate_managed_config_value(text,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'admin.validate_managed_config_value(text,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'admin.validate_managed_config_value(text,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'admin.validate_payment_plans_config(jsonb,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'admin.validate_reply_style_options(jsonb,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'assert: validator executable beyond the owner';
  END IF;
  IF obj_description('admin.managed_config_keys'::regclass, 'pg_class') NOT LIKE '%分发里加一个 WHEN%' THEN
    RAISE EXCEPTION 'assert: registry comment not updated';
  END IF;
END $$;
CREATE TABLE test_fixture.after_md5 AS
SELECT oid::regprocedure::text AS fn, md5(prosrc) AS md5sum FROM pg_proc WHERE pronamespace = 'admin'::regnamespace;
SQL
echo "ok: all managed keys keep their outcome; retired/unregistered keys rejected; chain and retired helpers dropped; owner-only"

"${admin_psql[@]}" >/dev/null <"$migration"
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
  IF EXISTS (SELECT oid::regprocedure::text, md5(prosrc) FROM pg_proc WHERE pronamespace = 'admin'::regnamespace
             EXCEPT SELECT fn, md5sum FROM test_fixture.after_md5) THEN
    RAISE EXCEPTION 'assert: re-run changed functions';
  END IF;
END $$;
SQL
echo "ok: re-run is a no-op"
echo "PASS: p3d flattened config validator migration"
