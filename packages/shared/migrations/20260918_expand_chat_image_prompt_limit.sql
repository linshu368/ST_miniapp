-- 20260918: 将图片描述数据库限制与 shared MAX_IMAGE_PROMPT_CHARS=1000 对齐。
-- domain: experience + app_core + admin
-- 前置：20260914_chat_message_images.sql、20260916_chat_image_description_drafts.sql 已执行。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE experience.chat_message_images
  DROP CONSTRAINT IF EXISTS chat_message_images_prompt_cn_check;
ALTER TABLE experience.chat_message_images
  ADD CONSTRAINT chat_message_images_prompt_cn_check
  CHECK (char_length(prompt_cn) BETWEEN 1 AND 1000) NOT VALID;
ALTER TABLE experience.chat_message_images
  VALIDATE CONSTRAINT chat_message_images_prompt_cn_check;

UPDATE app_core.runtime_config
SET value = '1000'::JSONB,
    version = version + 1,
    updated_at = now()
WHERE key = 'image_max_prompt_chars'
  AND value IS DISTINCT FROM '1000'::JSONB;

CREATE OR REPLACE FUNCTION admin.validate_image_generation_config_value(
  p_config_key TEXT,
  p_value JSONB
) RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_number NUMERIC;
  v_text TEXT;
  v_max_length INTEGER;
BEGIN
  IF p_config_key = 'image_generation_enabled' THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'image_generation_enabled must be a boolean' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key IN ('image_generation_credits', 'image_width', 'image_height', 'image_max_prompt_chars', 'image_max_output_bytes') THEN
    v_number := NULLIF(p_value #>> '{}', '')::NUMERIC;
    IF v_number IS NULL OR v_number <> floor(v_number) OR v_number <= 0 THEN
      RAISE EXCEPTION '% must be a positive integer', p_config_key USING ERRCODE = '22023';
    END IF;
    IF p_config_key = 'image_max_prompt_chars' AND v_number <> 1000 THEN
      RAISE EXCEPTION 'image_max_prompt_chars must stay aligned with shared MAX_IMAGE_PROMPT_CHARS=1000'
        USING ERRCODE = '22023';
    END IF;
    IF p_config_key IN ('image_width', 'image_height') AND (v_number < 256 OR v_number > 4096) THEN
      RAISE EXCEPTION '% must be between 256 and 4096', p_config_key USING ERRCODE = '22023';
    END IF;
    IF p_config_key = 'image_max_output_bytes' AND (v_number < 1048576 OR v_number > 52428800) THEN
      RAISE EXCEPTION 'image_max_output_bytes must be between 1MB and 50MB' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key IN (
    'image_price_label',
    'image_default_art_style',
    'image_prompt_policy',
    'image_prompt_over_limit_hint',
    'image_description_failed_hint',
    'image_generation_failed_hint',
    'image_failed_unknown_hint'
  ) THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION '% must be a string', p_config_key USING ERRCODE = '22023';
    END IF;
    v_text := trim(p_value #>> '{}');
    IF v_text = '' THEN
      RAISE EXCEPTION '% must not be empty', p_config_key USING ERRCODE = '22023';
    END IF;
    v_max_length := 200;
    IF p_config_key IN ('image_default_art_style', 'image_prompt_policy') THEN
      v_max_length := 1000;
    END IF;
    IF char_length(v_text) > v_max_length THEN
      RAISE EXCEPTION '% is too long', p_config_key USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  RAISE EXCEPTION 'unknown image generation config key: %', p_config_key
    USING ERRCODE = '22023';
END;
$$;

DO $$
DECLARE
  v_definition TEXT;
  v_raised BOOLEAN := FALSE;
BEGIN
  SELECT pg_get_constraintdef(c.oid)
    INTO v_definition
  FROM pg_constraint c
  WHERE c.conrelid = 'experience.chat_message_images'::REGCLASS
    AND c.conname = 'chat_message_images_prompt_cn_check';

  IF v_definition IS NULL OR position('1000' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'self-check failed: prompt_cn constraint is not aligned to 1000 -> %',
      COALESCE(v_definition, 'NULL');
  END IF;

  IF (SELECT value FROM app_core.runtime_config WHERE key = 'image_max_prompt_chars')
     IS DISTINCT FROM '1000'::JSONB THEN
    RAISE EXCEPTION 'self-check failed: image_max_prompt_chars runtime value is not 1000';
  END IF;

  PERFORM admin.validate_image_generation_config_value(
    'image_max_prompt_chars',
    '1000'::JSONB
  );
  BEGIN
    PERFORM admin.validate_image_generation_config_value(
      'image_max_prompt_chars',
      '200'::JSONB
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_raised := TRUE;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'self-check failed: image_max_prompt_chars accepted 200';
  END IF;
END;
$$;

COMMIT;

-- 执行后验证：
-- SELECT pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'experience.chat_message_images'::regclass
--   AND conname = 'chat_message_images_prompt_cn_check';
-- SELECT key, value, version FROM app_core.runtime_config WHERE key = 'image_max_prompt_chars';
