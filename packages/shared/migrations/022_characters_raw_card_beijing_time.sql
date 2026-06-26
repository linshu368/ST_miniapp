-- 022: 角色卡原始 JSON + 字段清理 + 北京时间时间戳
--
-- 目标：
--   1. 删除 miniapp.characters 的 is_default / is_published / is_active
--   2. 增加 raw_card jsonb，用于保存从 PNG 中解析出的原始角色卡 JSON
--   3. 将 created_at / updated_at 统一为北京时间墙上时间

BEGIN;

-- 旧字段相关索引先删，再删字段；IF EXISTS 保证线上状态不一致时仍可重复执行。
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
  '从 SillyTavern 角色卡 PNG 中解析出的原始角色卡 JSON，用于无损保留生态扩展字段';
COMMENT ON COLUMN miniapp.characters.created_at IS
  '北京时间墙上时间（Asia/Shanghai），不带时区';
COMMENT ON COLUMN miniapp.characters.updated_at IS
  '北京时间墙上时间（Asia/Shanghai），不带时区';

COMMIT;
