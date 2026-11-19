#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261119_db_reorg_retire_chat_images.sql as a NON-superuser:
# - the validator fixture is the production body (md5 969279438aec4fde02a547dc7caa21ff, from
#   20261118_db_reorg_p3d_flatten_config_validator.sql); after the migration its md5 is f23fcee0…, no chat image key
#   remains, retired keys are rejected as unmanaged and image plaza keys validate exactly as before;
# - the 15 keys are retired (release history kept), their drafts and runtime rows deleted, other keys untouched;
# - the four chat image functions are dropped, other functions kept; the table keeps its rows and loses API grants;
# - a rerun only reports zeros; an unfinished job or a drifted validator makes it refuse and change nothing.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261119_db_reorg_retire_chat_images.sql"
task_container="st-db-reorg-chat-images-${RANDOM}-$$"
trap 'docker rm -f "$task_container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE;
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
GRANT anon, authenticated, service_role TO app_admin;
CREATE DATABASE fixture OWNER app_admin;
SQL
psql_f() { docker exec -i "$task_container" psql -X -q -U app_admin -d fixture -v ON_ERROR_STOP=1 "$@"; }
check() { # label; SQL on stdin must print exactly "t"
  local got
  got=$(psql_f -At)
  if [[ "$got" != "t" ]]; then echo "FAIL: $1 (got: $got)"; exit 1; fi
  echo "ok: $1"
}
fixture() {
  psql_f >/dev/null <<'SQL'
DROP SCHEMA IF EXISTS admin, app_core, experience, billing CASCADE;
CREATE SCHEMA admin; CREATE SCHEMA app_core; CREATE SCHEMA experience; CREATE SCHEMA billing;
CREATE TABLE admin.managed_config_keys (
  config_key text PRIMARY KEY, managed_via text NOT NULL DEFAULT 'operations_config',
  retired_at timestamptz, note text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE admin.config_drafts (config_key text PRIMARY KEY REFERENCES admin.managed_config_keys, value jsonb);
CREATE TABLE admin.config_releases (id bigserial PRIMARY KEY, config_key text REFERENCES admin.managed_config_keys, value jsonb);
CREATE TABLE app_core.runtime_config (key text PRIMARY KEY, value jsonb, text_value text);
CREATE FUNCTION admin.is_managed_config_key(p_config_key text) RETURNS boolean LANGUAGE sql STABLE
  SET search_path = pg_catalog AS $fn$
    SELECT CASE WHEN p_config_key IS NULL THEN NULL ELSE EXISTS (
      SELECT 1 FROM admin.managed_config_keys m
      WHERE m.config_key = p_config_key AND m.managed_via = 'operations_config' AND m.retired_at IS NULL) END $fn$;
INSERT INTO admin.managed_config_keys (config_key)
SELECT unnest(ARRAY['image_generation_enabled','image_generation_credits','image_price_label','image_text_model_config',
  'image_prompt_policy','image_default_art_style','image_description_system_prompt','image_width','image_height',
  'image_max_prompt_chars','image_max_output_bytes','image_prompt_over_limit_hint','image_description_failed_hint',
  'image_generation_failed_hint','image_failed_unknown_hint','image_plaza_enabled','llm_model_catalog']);
INSERT INTO admin.config_drafts SELECT config_key, '1' FROM admin.managed_config_keys WHERE config_key LIKE 'image_%';
INSERT INTO admin.config_releases (config_key, value) SELECT config_key, '1' FROM admin.managed_config_keys;
INSERT INTO app_core.runtime_config (key, value) SELECT config_key, '1' FROM admin.managed_config_keys;
INSERT INTO app_core.runtime_config (key, value) VALUES ('unrelated_key', '2');
CREATE TABLE experience.chat_message_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL, lease_owner text, lease_expires_at timestamptz);
INSERT INTO experience.chat_message_images (status)
SELECT unnest(ARRAY['ready','failed','draft_ready','draft_failed','ready']);
GRANT ALL ON experience.chat_message_images TO anon, authenticated, service_role;
CREATE FUNCTION experience.claim_chat_image_jobs(p_worker_id text, p_limit integer, p_lease_seconds integer)
  RETURNS void LANGUAGE sql AS $f$ SELECT $f$;
CREATE FUNCTION billing.settle_image_generation(p_attempt_id uuid, p_user_id uuid, p_amount numeric, p_metadata jsonb)
  RETURNS void LANGUAGE sql AS $f$ SELECT $f$;
CREATE FUNCTION admin.validate_image_generation_config_value(p_config_key text, p_value jsonb)
  RETURNS void LANGUAGE sql AS $f$ SELECT $f$;
CREATE FUNCTION admin.validate_image_text_model_config(p_value jsonb) RETURNS void LANGUAGE sql AS $f$ SELECT $f$;
CREATE FUNCTION billing.settle_voice_generation(p_attempt_id uuid) RETURNS void LANGUAGE sql AS $f$ SELECT $f$;
SQL
  psql_f >/dev/null <<'SQL'
CREATE OR REPLACE FUNCTION admin.validate_managed_config_value(p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $prodfn$
-- 单层分发（数据库重组 3d）。加 key：admin.managed_config_keys 插一行 + 下面加一个 WHEN（长校验拆成具名函数）。
-- 字段细则在 shared zod；这里保证落库的形状，报错文案供运营平台显示。
DECLARE
  v_text text;
  v_length bigint;
  v_field text;
  v_rotation jsonb;
  v_value numeric;
  v_lower integer;
  v_upper integer;
BEGIN
  IF admin.is_managed_config_key(p_config_key) IS NOT TRUE THEN
    RAISE EXCEPTION 'config key is not managed by admin: %', p_config_key USING ERRCODE = '22023';
  END IF;

  -- 只收 JSON 值的 key：带 text_value 一律先拒（与原各层第一句一致）。
  IF p_text_value IS NOT NULL AND p_config_key IN (
    'miniapp_checkin_new_user_credits', 'miniapp_checkin_veteran_credits',
    'image_plaza_enabled', 'image_plaza_model_catalog', 'image_plaza_share_tip', 'image_plaza_tags',
    'vip_purchase_enabled', 'vip_reminders_enabled', 'vip_plans_config', 'vip_text_discount_rate',
    'vip_checkin_bonus_config', 'feature_free_trial_limits',
    'llm_provider_routing_config', 'image_text_model_config',
    'miniapp_invite_reward_rules', 'miniapp_invite_center_config',
    'image_generation_enabled', 'image_generation_credits', 'image_price_label', 'image_default_art_style',
    'image_width', 'image_height', 'image_max_prompt_chars', 'image_max_output_bytes', 'image_prompt_policy',
    'image_prompt_over_limit_hint', 'image_description_failed_hint', 'image_generation_failed_hint',
    'image_failed_unknown_hint',
    'lobby_ranking_params', 'pref_word_count_tiers'
  ) THEN
    RAISE EXCEPTION '% must not use text_value', p_config_key USING ERRCODE = '22023';
  END IF;

  CASE p_config_key
    -- 对话：模式、指令、回复风格、记忆 ----------------------------------------------------------
    WHEN 'drive_mode_options' THEN
      IF p_text_value IS NOT NULL OR p_value IS NULL OR jsonb_typeof(p_value) <> 'object'
         OR jsonb_typeof(p_value -> 'modes') IS DISTINCT FROM 'array'
         OR jsonb_typeof(p_value -> 'default_mode_id') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'drive mode options require a JSON object with modes and default_mode_id'
          USING ERRCODE = '22023';
      END IF;

    WHEN 'system_instructions' THEN
      IF p_value IS NOT NULL
         OR p_text_value IS NULL
         OR char_length(btrim(p_text_value)) = 0 THEN
        RAISE EXCEPTION 'system_instructions must store nonempty markdown in text_value only'
          USING ERRCODE = '22023';
      END IF;
      FOREACH v_field IN ARRAY ARRAY[
        '{{CHOICE_RULES}}', '{{STATUS_RULES}}', '{{MEMORY_RULES}}',
        '{{WORD_COUNT}}', '{{USER_CUSTOM_INSTRUCTIONS}}'
      ] LOOP
        IF position(v_field IN p_text_value) = 0 THEN
          RAISE EXCEPTION 'system_instructions is missing required placeholder %', v_field
            USING ERRCODE = '22023';
        END IF;
      END LOOP;

    WHEN 'choice_rules', 'status_rules', 'memory_rules' THEN
      IF p_text_value IS NOT NULL
         OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
         OR (SELECT count(*) FROM jsonb_object_keys(p_value)) <> 3
         OR EXISTS (
           SELECT 1 FROM jsonb_object_keys(p_value) AS key
           WHERE key NOT IN ('on_first_two_turns', 'on_later_turns', 'off')
         ) THEN
        RAISE EXCEPTION '% must be a three-field JSONB instruction-slot value', p_config_key
          USING ERRCODE = '22023';
      END IF;
      FOREACH v_field IN ARRAY ARRAY['on_first_two_turns', 'on_later_turns', 'off'] LOOP
        IF jsonb_typeof(p_value -> v_field) IS DISTINCT FROM 'string'
           OR char_length(btrim(p_value ->> v_field)) = 0 THEN
          RAISE EXCEPTION '% field % must be a nonempty string', p_config_key, v_field
            USING ERRCODE = '22023';
        END IF;
      END LOOP;

    WHEN 'reply_style_options' THEN
      PERFORM admin.validate_reply_style_options(p_value, p_text_value);

    WHEN 'pref_word_count_tiers' THEN
      PERFORM admin.validate_pref_word_count_tiers(p_value);

    WHEN 'story_memory_config' THEN
      IF p_text_value IS NOT NULL OR p_value IS NULL OR jsonb_typeof(p_value) <> 'object' THEN
        RAISE EXCEPTION 'story memory config requires a JSON object' USING ERRCODE = '22023';
      END IF;

    WHEN 'story_memory_prompt' THEN
      v_text := btrim(p_text_value, U&'\0009\000A\000B\000C\000D\0020\00A0\3000\FEFF');
      SELECT coalesce(sum(CASE WHEN ascii(glyph) > 65535 THEN 2 ELSE 1 END), 0)
        INTO v_length FROM regexp_split_to_table(v_text, '') AS glyph WHERE glyph <> '';
      IF p_value IS NOT NULL OR p_text_value IS NULL OR v_length = 0 OR v_length > 20000 THEN
        RAISE EXCEPTION 'story memory prompt requires text only, between 1 and 20000 characters'
          USING ERRCODE = '22023';
      END IF;

    -- 模型与计费 ---------------------------------------------------------------------------------
    WHEN 'llm_model_catalog' THEN
      PERFORM admin.validate_model_catalog_core(p_value);
      PERFORM admin.validate_model_catalog_prd(p_value);

    WHEN 'llm_pricing_config' THEN
      PERFORM admin.validate_fixed_llm_deduction_config(p_value);

    WHEN 'llm_provider_routing_config' THEN
      PERFORM admin.validate_llm_provider_routing_config(p_value);

    WHEN 'free_zone_config' THEN
      IF p_text_value IS NOT NULL OR p_value IS NULL OR jsonb_typeof(p_value) <> 'object' THEN
        RAISE EXCEPTION 'free zone config requires a JSON object' USING ERRCODE = '22023';
      END IF;

    WHEN 'miniapp_character_free_chat_quota_limit' THEN
      IF p_value IS NULL
         OR jsonb_typeof(p_value) IS DISTINCT FROM 'number'
         OR (p_value #>> '{}')::NUMERIC <> trunc((p_value #>> '{}')::NUMERIC)
         OR (p_value #>> '{}')::NUMERIC < 1 THEN
        RAISE EXCEPTION
          'miniapp_character_free_chat_quota_limit must be a positive JSON integer'
          USING ERRCODE = '22023';
      END IF;

    WHEN 'miniapp_free_quota_exhausted_dialog_config' THEN
      PERFORM admin.validate_free_quota_exhausted_dialog_config(p_value);

    -- 积分、签到、邀请、充值、VIP ---------------------------------------------------------------
    WHEN 'miniapp_new_user_signup_bonus_credits' THEN
      IF p_value IS NULL
         OR jsonb_typeof(p_value) IS DISTINCT FROM 'number'
         OR (p_value #>> '{}')::NUMERIC < 0 THEN
        RAISE EXCEPTION '% must be a nonnegative JSON number', p_config_key
          USING ERRCODE = '22023';
      END IF;

    WHEN 'miniapp_checkin_new_user_credits', 'miniapp_checkin_veteran_credits' THEN
      IF p_value IS NULL
         OR jsonb_typeof(p_value) IS DISTINCT FROM 'number'
         OR (p_value #>> '{}') !~ '^[0-9]+$'
         OR (p_value #>> '{}')::integer > 1000000 THEN
        RAISE EXCEPTION '% must be a nonnegative integer JSON number', p_config_key
          USING ERRCODE = '22023';
      END IF;

    WHEN 'miniapp_invite_reward_rules' THEN
      PERFORM admin.validate_invite_reward_rules(p_value);

    WHEN 'miniapp_invite_center_config' THEN
      PERFORM admin.validate_invite_center_config(p_value);

    WHEN 'miniapp_invite_entry_enabled' THEN
      IF p_text_value IS NOT NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION 'miniapp_invite_entry_enabled must be a JSON boolean' USING ERRCODE = '22023';
      END IF;

    WHEN 'miniapp_payment_plans' THEN
      PERFORM admin.validate_payment_plans_config(p_value, p_text_value);

    WHEN 'vip_purchase_enabled', 'vip_reminders_enabled' THEN
      IF jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION '% must be a JSON boolean', p_config_key USING ERRCODE = '22023';
      END IF;

    WHEN 'vip_plans_config' THEN
      PERFORM admin.validate_vip_plans_config(p_value);

    WHEN 'vip_text_discount_rate' THEN
      PERFORM admin.validate_vip_text_discount_rate(p_value);

    WHEN 'vip_checkin_bonus_config' THEN
      PERFORM admin.validate_vip_checkin_bonus_config(p_value);

    WHEN 'feature_free_trial_limits' THEN
      PERFORM admin.validate_feature_free_trial_limits(p_value);

    -- 大厅与角色卡 -------------------------------------------------------------------------------
    WHEN 'lobby_ranking_params' THEN
      PERFORM admin.validate_lobby_ranking_params(p_value);
      IF p_value ? 'rotation' THEN
        v_rotation := p_value -> 'rotation';
        IF jsonb_typeof(v_rotation) IS DISTINCT FROM 'object'
          OR jsonb_typeof(v_rotation -> 'enabled') IS DISTINCT FROM 'boolean' THEN
          RAISE EXCEPTION 'Invalid lobby rotation configuration' USING ERRCODE = '22023';
        END IF;
        FOR v_field, v_lower, v_upper IN SELECT * FROM (VALUES
          ('interval_hours', 1, 168), ('max_repeat', 0, 12),
          ('exploration_count', 0, 2), ('rollout_percent', 0, 100)
        ) AS bounds(field, lower_bound, upper_bound)
        LOOP
          IF jsonb_typeof(v_rotation -> v_field) IS DISTINCT FROM 'number' THEN
            RAISE EXCEPTION 'Invalid lobby rotation field %', v_field USING ERRCODE = '22023';
          END IF;
          v_value := (v_rotation ->> v_field)::numeric;
          IF v_value <> trunc(v_value) OR v_value < v_lower OR v_value > v_upper THEN
            RAISE EXCEPTION 'Invalid lobby rotation range %', v_field USING ERRCODE = '22023';
          END IF;
        END LOOP;
      END IF;

    WHEN 'creator_character_review_prompt' THEN
      v_text := btrim(p_text_value, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
      SELECT coalesce(sum(CASE WHEN ascii(glyph) > 65535 THEN 2 ELSE 1 END), 0)
        INTO v_length FROM regexp_split_to_table(v_text, '') AS glyph WHERE glyph <> '';
      IF p_value IS NOT NULL OR p_text_value IS NULL OR v_length = 0 OR v_length > 12000 THEN
        RAISE EXCEPTION 'creator review policy requires text only, between 1 and 12000 characters'
          USING ERRCODE = '22023';
      END IF;

    -- 图片：生成、描述、广场、视频广场 -----------------------------------------------------------
    WHEN 'image_plaza_video_model_catalog' THEN
      IF p_text_value IS NOT NULL THEN
        RAISE EXCEPTION 'video catalog must not use text_value' USING ERRCODE = '22023';
      END IF;
      PERFORM admin.validate_image_plaza_video_model_catalog(p_value);

    WHEN 'image_generation_enabled', 'image_generation_credits', 'image_price_label', 'image_default_art_style',
         'image_width', 'image_height', 'image_max_prompt_chars', 'image_max_output_bytes', 'image_prompt_policy',
         'image_prompt_over_limit_hint', 'image_description_failed_hint', 'image_generation_failed_hint',
         'image_failed_unknown_hint' THEN
      PERFORM admin.validate_image_generation_config_value(p_config_key, p_value);

    WHEN 'image_text_model_config' THEN
      PERFORM admin.validate_image_text_model_config(p_value);

    WHEN 'image_description_system_prompt' THEN
      IF p_value IS NOT NULL OR p_text_value IS NULL OR char_length(btrim(p_text_value)) = 0
         OR char_length(p_text_value) > 12000 THEN
        RAISE EXCEPTION 'image_description_system_prompt must use a nonempty text_value up to 12000 chars'
          USING ERRCODE = '22023';
      END IF;

    WHEN 'image_plaza_enabled' THEN
      IF jsonb_typeof(p_value) <> 'boolean' THEN
        RAISE EXCEPTION 'image_plaza_enabled must be boolean' USING ERRCODE = '22023';
      END IF;

    WHEN 'image_plaza_model_catalog', 'image_plaza_share_tip', 'image_plaza_tags' THEN
      IF jsonb_typeof(p_value) NOT IN ('object', 'array') THEN
        RAISE EXCEPTION '% has invalid shape', p_config_key USING ERRCODE = '22023';
      END IF;
      CASE p_config_key
        WHEN 'image_plaza_model_catalog' THEN PERFORM admin.validate_image_plaza_model_catalog(p_value);
        WHEN 'image_plaza_share_tip' THEN PERFORM admin.validate_image_plaza_share_tip(p_value);
        ELSE PERFORM admin.validate_image_plaza_tags(p_value);
      END CASE;

    ELSE
      RAISE EXCEPTION 'managed config validation is missing for key: %', p_config_key
        USING ERRCODE = '22023';
  END CASE;
END;
$prodfn$;
SQL
}

fixture
check 'fixture validator is the production body' <<'SQL'
SELECT md5(prosrc) = '969279438aec4fde02a547dc7caa21ff' FROM pg_proc
WHERE oid = 'admin.validate_managed_config_value(text,jsonb,text)'::regprocedure;
SQL
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'keys retired 15, drafts deleted 15, runtime rows deleted 15, functions dropped 4'* ]] ||
  { echo "FAIL: first apply output: $out"; exit 1; }
check 'validator rewritten: expected md5, no chat image key left' <<'SQL'
SELECT md5(prosrc) = 'f23fcee068b6d3e2da2efe91b7c2bf7a'
  AND prosrc !~ $re$'image_(?!plaza)[a-z_]+'$re$
  AND prosrc ~ 'image_plaza_enabled'
FROM pg_proc WHERE oid = 'admin.validate_managed_config_value(text,jsonb,text)'::regprocedure;
SQL
check 'keys retired with history kept; drafts and runtime rows of other keys untouched' <<'SQL'
SELECT (SELECT count(*) FROM admin.managed_config_keys WHERE retired_at IS NOT NULL) = 15
  AND (SELECT count(*) FROM admin.config_releases) = 17
  AND (SELECT array_agg(config_key ORDER BY config_key) FROM admin.config_drafts) = ARRAY['image_plaza_enabled']
  AND (SELECT array_agg(key ORDER BY key) FROM app_core.runtime_config) = ARRAY['image_plaza_enabled','llm_model_catalog','unrelated_key'];
SQL
check 'chat image functions dropped, others kept; table rows kept and API grants revoked' <<'SQL'
SELECT to_regprocedure('experience.claim_chat_image_jobs(text,integer,integer)') IS NULL
  AND to_regprocedure('billing.settle_image_generation(uuid,uuid,numeric,jsonb)') IS NULL
  AND to_regprocedure('admin.validate_image_generation_config_value(text,jsonb)') IS NULL
  AND to_regprocedure('admin.validate_image_text_model_config(jsonb)') IS NULL
  AND to_regprocedure('billing.settle_voice_generation(uuid)') IS NOT NULL
  AND (SELECT count(*) FROM experience.chat_message_images) = 5
  AND NOT has_table_privilege('service_role', 'experience.chat_message_images', 'SELECT')
  AND NOT has_table_privilege('service_role', 'experience.chat_message_images', 'INSERT')
  AND NOT has_table_privilege('anon', 'experience.chat_message_images', 'SELECT');
SQL
for key in image_generation_enabled image_text_model_config image_description_system_prompt; do
  if out=$(psql_f -c "SELECT admin.validate_managed_config_value('$key', 'true'::jsonb, NULL)" 2>&1); then
    echo "FAIL: retired key $key accepted"; exit 1
  fi
  [[ "$out" == *'config key is not managed by admin'* ]] || { echo "FAIL: $key message: $out"; exit 1; }
done
echo 'ok: retired keys are rejected as unmanaged'
psql_f -c "SELECT admin.validate_managed_config_value('image_plaza_enabled', 'true'::jsonb, NULL)" >/dev/null
if psql_f -c "SELECT admin.validate_managed_config_value('image_plaza_enabled', '\"yes\"'::jsonb, NULL)" >/dev/null 2>&1; then
  echo 'FAIL: image_plaza_enabled accepted a string'; exit 1
fi
if psql_f -c "SELECT admin.validate_managed_config_value('image_plaza_enabled', 'true'::jsonb, 'x')" >/dev/null 2>&1; then
  echo 'FAIL: image_plaza_enabled accepted text_value'; exit 1
fi
echo 'ok: image plaza keys validate as before (boolean ok, string and text_value rejected)'
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'keys retired 0, drafts deleted 0, runtime rows deleted 0, functions dropped 0'* ]] ||
  { echo "FAIL: rerun output: $out"; exit 1; }
echo 'ok: rerun reports zeros'

# Refusals leave everything as it was.
fixture
psql_f -c "INSERT INTO experience.chat_message_images (status) VALUES ('pending')" >/dev/null
if psql_f <"$migration" >/dev/null 2>&1; then echo 'FAIL: unfinished job not refused'; exit 1; fi
check 'refused with an unfinished job (nothing changed)' <<'SQL'
SELECT (SELECT count(*) FROM admin.managed_config_keys WHERE retired_at IS NOT NULL) = 0
  AND (SELECT count(*) FROM app_core.runtime_config) = 18
  AND to_regprocedure('billing.settle_image_generation(uuid,uuid,numeric,jsonb)') IS NOT NULL
  AND md5((SELECT prosrc FROM pg_proc WHERE oid = 'admin.validate_managed_config_value(text,jsonb,text)'::regprocedure))
      = '969279438aec4fde02a547dc7caa21ff';
SQL
fixture
psql_f >/dev/null <<'SQL'
DO $d$ BEGIN
  EXECUTE replace(pg_get_functiondef('admin.validate_managed_config_value(text,jsonb,text)'::regprocedure),
                  '单层分发（数据库重组 3d）', '单层分发（数据库重组 3d，漂移）');
END $d$;
SQL
if psql_f <"$migration" >/dev/null 2>&1; then echo 'FAIL: drifted validator not refused'; exit 1; fi
check 'refused with a drifted validator (nothing changed)' <<'SQL'
SELECT (SELECT count(*) FROM admin.managed_config_keys WHERE retired_at IS NOT NULL) = 0
  AND to_regprocedure('experience.claim_chat_image_jobs(text,integer,integer)') IS NOT NULL;
SQL
echo 'all checks passed'
