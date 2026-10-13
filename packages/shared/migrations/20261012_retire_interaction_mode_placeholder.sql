-- Retire the obsolete {{INTERACTION_MODE}} contract without rewriting history.
--
-- Release order:
--   1. Apply this migration.
--   2. Publish the canonical system_instructions text (it contains only the two
--      remaining placeholders). The old backend is compatible because replacing
--      a missing token is a no-op.
--   3. Deploy the backend that no longer reads interaction_mode_blocks.
--
-- Rollback: deploy the previous backend and rename the saved predecessor back
-- to validate_managed_config_value; do not delete existing runtime config data.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('admin.validate_managed_config_value(text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'missing admin.validate_managed_config_value(text,jsonb,text)';
  END IF;
  IF to_regprocedure('admin.validate_managed_config_value_before_rich_reply_protocol(text,jsonb,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'rich reply protocol validator predecessor already exists';
  END IF;
END;
$$;

-- Preserve the current validator in full.  The wrapper intercepts only the
-- changed key, so unrelated config validation cannot silently drift.
ALTER FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  RENAME TO validate_managed_config_value_before_rich_reply_protocol;

CREATE OR REPLACE FUNCTION admin.validate_managed_config_value(
  p_config_key TEXT,
  p_value JSONB,
  p_text_value TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_config_key = 'system_instructions' THEN
    IF p_value IS NOT NULL THEN
      RAISE EXCEPTION 'system_instructions must store markdown in text_value (value must be null)'
        USING ERRCODE = '22023';
    END IF;
    IF p_text_value IS NULL OR char_length(btrim(p_text_value)) = 0 THEN
      RAISE EXCEPTION 'system_instructions text_value must be a nonempty markdown string'
        USING ERRCODE = '22023';
    END IF;
    IF position('{{WORD_COUNT}}' IN p_text_value) = 0
       OR position('{{USER_CUSTOM_INSTRUCTIONS}}' IN p_text_value) = 0 THEN
      RAISE EXCEPTION
        'system_instructions must contain {{WORD_COUNT}} and {{USER_CUSTOM_INSTRUCTIONS}}'
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  PERFORM admin.validate_managed_config_value_before_rich_reply_protocol(
    p_config_key,
    p_value,
    p_text_value
  );
END;
$$;

REVOKE ALL ON FUNCTION admin.validate_managed_config_value_before_rich_reply_protocol(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  v_raised BOOLEAN := FALSE;
BEGIN
  PERFORM admin.validate_managed_config_value(
    'system_instructions',
    NULL,
    '长度：{{WORD_COUNT}}\n偏好：{{USER_CUSTOM_INSTRUCTIONS}}'
  );

  BEGIN
    PERFORM admin.validate_managed_config_value(
      'system_instructions',
      NULL,
      '长度：{{WORD_COUNT}}'
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_raised := TRUE;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'self-check failed: missing user custom instructions was accepted';
  END IF;
END;
$$;

COMMIT;
NOTIFY pgrst, 'reload schema';
