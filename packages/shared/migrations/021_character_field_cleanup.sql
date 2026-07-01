-- 021: 角色卡字段对齐 + 系统兜底卡 config 化
--
-- 目标：
--   1. 删除 miniapp.characters 表的 is_published / is_active / is_default 三个冗余字段
--   2. 统一以 enabled 为唯一上下架字段（大厅 + provision 共用）
--   3. 将原 is_default 语义迁移到 miniapp.runtime_config.system_fallback_character_id
--
-- 概念澄清：
--   "系统兜底卡"不是"用户默认角色"。用户进大厅主动选角色，不存在"默认进入某个对话"的场景。
--   system_fallback_character_id 的职责是：当 settings.json 中 active_character 引用失效时
--   （角色被下架 / PNG 缺失）的系统回退值，用户感知不到这个配置。
--
-- 回滚 SQL（见 PR 描述）

BEGIN;

-- ── 1. 写入系统兜底卡 ID 到 runtime_config ──────────────────────────────────
-- 取当前 is_default=true 的卡 ID，如果没有则取 sort_order 最小的 enabled 卡
INSERT INTO miniapp.runtime_config (key, value, description, version, updated_at)
VALUES (
  'system_fallback_character_id',
  (
    SELECT to_jsonb(id::text)
    FROM miniapp.characters
    WHERE is_default = true
    LIMIT 1
  ),
  '系统兜底卡 UUID。当 settings.json 中 active_character 引用失效（角色被下架/PNG 缺失）时的回退值。用户感知不到此配置。不是"用户默认角色"。',
  1,
  now()
)
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  description = EXCLUDED.description,
  updated_at = now();

-- 兜底：如果没有 is_default=true 的卡，用 enabled=true + sort_order 最小的卡
UPDATE miniapp.runtime_config
SET value = (
  SELECT to_jsonb(id::text)
  FROM miniapp.characters
  WHERE enabled = true
  ORDER BY sort_order ASC, created_at ASC
  LIMIT 1
)
WHERE key = 'system_fallback_character_id'
  AND value IS NULL;

-- ── 2. 新建 enabled + sort_order 索引（替代原来的 is_published + is_active 索引）──
CREATE INDEX IF NOT EXISTS idx_characters_enabled_sort
  ON miniapp.characters(enabled, sort_order)
  WHERE enabled = true;

-- ── 3. 删除废弃索引 ─────────────────────────────────────────────────────────
DROP INDEX IF EXISTS miniapp.idx_characters_one_default;
DROP INDEX IF EXISTS miniapp.idx_characters_published_active_sort;

-- ── 4. 删除废弃字段 ─────────────────────────────────────────────────────────
ALTER TABLE miniapp.characters
  DROP COLUMN IF EXISTS is_default,
  DROP COLUMN IF EXISTS is_published,
  DROP COLUMN IF EXISTS is_active;

-- ── 5. 清理废弃的字段注释（字段已删除，注释自动清除，此处为显式声明意图）──
-- PG 删除字段时自动清除其 COMMENT，无需额外操作

-- ── 6. 更新表注释 ───────────────────────────────────────────────────────────
COMMENT ON COLUMN miniapp.characters.enabled IS
  '是否上架。大厅展示 + provision 下发统一以此字段过滤（enabled=true 才可见/下发）';
COMMENT ON COLUMN miniapp.characters.sort_order IS
  '大厅展示顺序，数字越小越靠前。同 sort_order 时按 created_at 兜底';

COMMIT;
