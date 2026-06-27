-- Character field cleanup: remove is_default / is_published / is_active
-- Aligns with shared migration 021_character_field_cleanup.sql

-- Insert system fallback character ID into runtime_config
-- (migrates the is_default=true concept to runtime_config)
INSERT INTO miniapp.runtime_config (key, value, description, version, updated_at)
SELECT
  'system_fallback_character_id',
  to_jsonb(c.id::text),
  '系统兜底卡 UUID。当 active_character 引用失效时的回退值。',
  1,
  now()
FROM miniapp.characters c
WHERE c.is_default = true
LIMIT 1
ON CONFLICT (key) DO NOTHING;

-- Create new index before dropping old ones
CREATE INDEX IF NOT EXISTS idx_characters_enabled_sort
  ON miniapp.characters(enabled, sort_order)
  WHERE enabled = true;

-- Drop deprecated indexes
DROP INDEX IF EXISTS miniapp.idx_characters_one_default;
DROP INDEX IF EXISTS miniapp.idx_characters_published_active_sort;

-- Drop deprecated columns
ALTER TABLE miniapp.characters
  DROP COLUMN IF EXISTS is_default,
  DROP COLUMN IF EXISTS is_published,
  DROP COLUMN IF EXISTS is_active;
