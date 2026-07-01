-- Phase 0: remove self-hosted miniapp chat storage and align character flags.

DROP TABLE IF EXISTS miniapp.app_messages;
DROP TABLE IF EXISTS miniapp.app_sessions;

ALTER TABLE miniapp.characters
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN,
  ADD COLUMN IF NOT EXISTS sort_order INTEGER,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'miniapp'
      AND table_name = 'characters'
      AND column_name = 'enabled'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'miniapp'
      AND table_name = 'characters'
      AND column_name = 'is_published'
  ) THEN
    ALTER TABLE miniapp.characters RENAME COLUMN enabled TO is_published;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'miniapp'
      AND table_name = 'characters'
      AND column_name = 'is_published'
  ) THEN
    ALTER TABLE miniapp.characters ADD COLUMN is_published BOOLEAN;
  END IF;
END $$;

UPDATE miniapp.characters SET is_default = false WHERE is_default IS NULL;
UPDATE miniapp.characters SET sort_order = 0 WHERE sort_order IS NULL;
UPDATE miniapp.characters SET is_published = true WHERE is_published IS NULL;
UPDATE miniapp.characters SET is_active = true WHERE is_active IS NULL;

ALTER TABLE miniapp.characters
  ALTER COLUMN is_default SET DEFAULT false,
  ALTER COLUMN is_default SET NOT NULL,
  ALTER COLUMN sort_order SET DEFAULT 0,
  ALTER COLUMN sort_order SET NOT NULL,
  ALTER COLUMN is_published SET DEFAULT true,
  ALTER COLUMN is_published SET NOT NULL,
  ALTER COLUMN is_active SET DEFAULT true,
  ALTER COLUMN is_active SET NOT NULL;

DROP INDEX IF EXISTS miniapp.idx_characters_enabled_sort;

CREATE UNIQUE INDEX IF NOT EXISTS idx_characters_one_default
  ON miniapp.characters((1))
  WHERE is_default = true;

CREATE INDEX IF NOT EXISTS idx_characters_published_active_sort
  ON miniapp.characters(is_published, is_active, sort_order)
  WHERE is_published = true AND is_active = true;

COMMENT ON COLUMN miniapp.characters.is_default IS
  '新用户初始化时是否自动激活此卡（user_st_settings.settings_jsonb.active_character 取此卡的 platform_<id>）';
COMMENT ON COLUMN miniapp.characters.is_published IS
  '是否上架。大厅仅展示 is_published=true 且 is_active=true 的卡';
COMMENT ON COLUMN miniapp.characters.is_active IS
  '是否可用。停用后老用户已物化卡不可继续使用';
COMMENT ON COLUMN miniapp.characters.sort_order IS
  '大厅展示顺序，数字越小越靠前。同 sort_order 时按 created_at 兜底';
