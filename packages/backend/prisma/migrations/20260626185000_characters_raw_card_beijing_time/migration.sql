-- Character raw card storage and Beijing-time timestamps.

DROP INDEX IF EXISTS miniapp.idx_characters_one_default;
DROP INDEX IF EXISTS miniapp.idx_characters_published_active_sort;

ALTER TABLE miniapp.characters
  DROP COLUMN IF EXISTS is_default,
  DROP COLUMN IF EXISTS is_published,
  DROP COLUMN IF EXISTS is_active,
  ADD COLUMN IF NOT EXISTS raw_card JSONB;

DO $$
DECLARE
  v_created_type TEXT;
  v_updated_type TEXT;
BEGIN
  SELECT data_type
  INTO v_created_type
  FROM information_schema.columns
  WHERE table_schema = 'miniapp'
    AND table_name = 'characters'
    AND column_name = 'created_at';

  SELECT data_type
  INTO v_updated_type
  FROM information_schema.columns
  WHERE table_schema = 'miniapp'
    AND table_name = 'characters'
    AND column_name = 'updated_at';

  IF v_created_type = 'timestamp with time zone' THEN
    ALTER TABLE miniapp.characters
      ALTER COLUMN created_at TYPE TIMESTAMP(6) WITHOUT TIME ZONE
      USING timezone('Asia/Shanghai', created_at);
  ELSE
    ALTER TABLE miniapp.characters
      ALTER COLUMN created_at TYPE TIMESTAMP(6) WITHOUT TIME ZONE
      USING created_at::TIMESTAMP(6);
  END IF;

  IF v_updated_type = 'timestamp with time zone' THEN
    ALTER TABLE miniapp.characters
      ALTER COLUMN updated_at TYPE TIMESTAMP(6) WITHOUT TIME ZONE
      USING timezone('Asia/Shanghai', updated_at);
  ELSE
    ALTER TABLE miniapp.characters
      ALTER COLUMN updated_at TYPE TIMESTAMP(6) WITHOUT TIME ZONE
      USING updated_at::TIMESTAMP(6);
  END IF;
END $$;

ALTER TABLE miniapp.characters
  ALTER COLUMN created_at SET DEFAULT timezone('Asia/Shanghai', now()),
  ALTER COLUMN updated_at SET DEFAULT timezone('Asia/Shanghai', now());

COMMENT ON COLUMN miniapp.characters.raw_card IS
  'Raw character-card JSON parsed from SillyTavern PNG metadata.';
COMMENT ON COLUMN miniapp.characters.created_at IS
  'Beijing wall-clock time (Asia/Shanghai), stored without time zone.';
COMMENT ON COLUMN miniapp.characters.updated_at IS
  'Beijing wall-clock time (Asia/Shanghai), stored without time zone.';
