-- Local-only sanitized production catalog shape (2026-11-18); never apply remotely.
ALTER TABLE billing.wallet_ledger DROP CONSTRAINT wallet_ledger_entry_type_check;
ALTER TABLE billing.wallet_ledger ADD CONSTRAINT wallet_ledger_entry_type_check CHECK (((entry_type = ANY (ARRAY['recharge'::text, 'chat_debit'::text, 'refund'::text, 'adjustment'::text, 'checkin_bonus'::text, 'wish_reward'::text, 'invite_reward'::text, 'community_reward'::text, 'image_generation'::text, 'vip_bonus'::text, 'image_plaza_generation'::text, 'image_plaza_share_reward'::text])) OR (entry_type = ANY (ARRAY['creator_reward'::text, 'creator_reward_reversal'::text])) OR (entry_type = 'survey_reward'::text))) NOT VALID;
CREATE OR REPLACE FUNCTION admin.validate_image_plaza_tags(p_value jsonb)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_tag JSONB;
  v_ids TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'array' OR jsonb_array_length(p_value) > 80 THEN
    RAISE EXCEPTION 'image_plaza_tags has invalid shape' USING ERRCODE = '22023';
  END IF;
  FOR v_tag IN SELECT value FROM jsonb_array_elements(p_value) LOOP
    IF char_length(btrim(COALESCE(v_tag->>'id', ''))) NOT BETWEEN 1 AND 40
       OR v_tag->>'id' = 'all'
       OR char_length(btrim(COALESCE(v_tag->>'label', ''))) NOT BETWEEN 1 AND 40
       OR jsonb_typeof(v_tag->'enabled') IS DISTINCT FROM 'boolean'
       OR COALESCE(v_tag->>'sort_order', '') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'image plaza tag is invalid' USING ERRCODE = '22023';
    END IF;
    IF (v_tag->>'id') = ANY(v_ids) THEN
      RAISE EXCEPTION 'image plaza tag id is duplicated' USING ERRCODE = '22023';
    END IF;
    v_ids := array_append(v_ids, v_tag->>'id');
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION admin.is_managed_config_key(p_config_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
    SELECT CASE WHEN p_config_key IS NULL THEN NULL ELSE EXISTS (
      SELECT 1 FROM admin.managed_config_keys m
      WHERE m.config_key = p_config_key AND m.managed_via = 'operations_config' AND m.retired_at IS NULL
    ) END
  $function$
;

CREATE OR REPLACE FUNCTION admin.validate_managed_config_value(p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
    BEGIN
      -- 字段规则在 shared zod；库里只保证存的是带 modes 数组的 JSON 对象。
      IF p_config_key = 'drive_mode_options' THEN
        IF p_text_value IS NOT NULL OR p_value IS NULL OR jsonb_typeof(p_value) <> 'object'
           OR jsonb_typeof(p_value -> 'modes') IS DISTINCT FROM 'array'
           OR jsonb_typeof(p_value -> 'default_mode_id') IS DISTINCT FROM 'string' THEN
          RAISE EXCEPTION 'drive mode options require a JSON object with modes and default_mode_id'
            USING ERRCODE = '22023';
        END IF;
        RETURN;
      END IF;
      PERFORM admin.validate_managed_config_value_before_drive_mode(p_config_key, p_value, p_text_value);
    END $function$
;

