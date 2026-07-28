-- 首页「推荐 / 最新」排序的数据支撑。
-- 推荐页第 9 张起按聊天转化率排序：进入聊天去重用户数为分母，聊满 5 轮的去重用户数为分子。
-- 最新页按角色最后一次上架时间倒序，重新上架即刷新。
-- 本迁移只新增索引、视图、列与触发器，不改动既有函数。

BEGIN;

-- ── 1. 转化率聚合所需索引 ────────────────────────────────────────────────────
-- 聚合按 (character_id, user_id) 分组并取该组最大轮次，三列复合索引可走 index-only scan。
CREATE INDEX IF NOT EXISTS idx_chat_history_character_user_round
  ON miniapp.chat_history (character_id, user_id, user_character_round)
  WHERE character_id IS NOT NULL;

-- ── 2. 角色聊天转化率视图 ────────────────────────────────────────────────────
-- entered_users   : 进入过该角色聊天的去重用户数（分母）
-- converted_users : 与该角色聊天达到 5 轮及以上的去重用户数（分子）
-- user_character_round 由 030 的触发器按 (user_id, character_id) 递增，最大值即累计轮次。
CREATE OR REPLACE VIEW miniapp.character_engagement_stats AS
SELECT
  pair.character_id,
  COUNT(*)::BIGINT                                        AS entered_users,
  COUNT(*) FILTER (WHERE pair.max_round >= 5)::BIGINT     AS converted_users
FROM (
  SELECT
    character_id,
    user_id,
    MAX(COALESCE(user_character_round, 1)) AS max_round
  FROM miniapp.chat_history
  WHERE character_id IS NOT NULL
  GROUP BY character_id, user_id
) AS pair
GROUP BY pair.character_id;

COMMENT ON VIEW miniapp.character_engagement_stats IS
  '角色聊天转化率聚合：entered_users 为进入聊天去重用户数，converted_users 为聊满 5 轮去重用户数。';

GRANT SELECT ON miniapp.character_engagement_stats TO service_role, postgres;

-- ── 3. 角色最后上架时间 ──────────────────────────────────────────────────────
ALTER TABLE miniapp.characters
  ADD COLUMN IF NOT EXISTS last_listed_at TIMESTAMPTZ;

COMMENT ON COLUMN miniapp.characters.last_listed_at IS
  '角色最后一次上架（enabled 置为 true 且未归档）的时间，供首页「最新」排序使用。';

-- 回填：优先取角色布局发布历史中最后一次把该角色列为上架的时间，缺失时退回创建时间。
-- characters.created_at 是不带时区的上海本地时间，released_at 是 TIMESTAMPTZ，
-- 两者必须换算到同一时间轴，否则回填结果会整体偏移 8 小时。
DO $$
BEGIN
  IF to_regclass('admin.character_layout_releases') IS NOT NULL THEN
    UPDATE miniapp.characters c
    SET last_listed_at = COALESCE(
      (
        SELECT MAX(r.released_at)
        FROM admin.character_layout_releases r
        WHERE c.id = ANY(r.listed_ids)
      ),
      c.created_at AT TIME ZONE 'Asia/Shanghai'
    )
    WHERE c.last_listed_at IS NULL;
  ELSE
    UPDATE miniapp.characters
    SET last_listed_at = created_at AT TIME ZONE 'Asia/Shanghai'
    WHERE last_listed_at IS NULL;
  END IF;
END;
$$;

-- 上架时间由触发器维护，避免改写 admin 侧既有的发布与上下架函数。
CREATE OR REPLACE FUNCTION miniapp.tf_track_character_listing()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- 由「未上架」转为「已上架」时刷新；已在架状态下的其它更新不刷新，避免编辑角色就顶到最新页最前。
  IF NEW.enabled AND NEW.archived_at IS NULL
     AND (
       TG_OP = 'INSERT'
       OR OLD.enabled IS DISTINCT FROM TRUE
       OR OLD.archived_at IS NOT NULL
     )
  THEN
    NEW.last_listed_at := now();
  END IF;

  IF NEW.last_listed_at IS NULL THEN
    NEW.last_listed_at := COALESCE(NEW.created_at AT TIME ZONE 'Asia/Shanghai', now());
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_characters_track_listing ON miniapp.characters;
CREATE TRIGGER trg_characters_track_listing
BEFORE INSERT OR UPDATE OF enabled, archived_at ON miniapp.characters
FOR EACH ROW
EXECUTE FUNCTION miniapp.tf_track_character_listing();

-- 最新页排序索引：仅覆盖大厅可见角色。
CREATE INDEX IF NOT EXISTS idx_characters_last_listed_at
  ON miniapp.characters (last_listed_at DESC)
  WHERE enabled AND archived_at IS NULL;

COMMIT;
