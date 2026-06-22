-- 004: 为 miniapp.characters 补充同步管控字段
--
-- 分区归属：A 类（平台管控）
-- 形态：资源型-平台池（设计文档"概念名"为 platform_characters，物理表复用 miniapp.characters）
-- 数据流：Supabase → ST（单向下发到 ST data/<handle>/characters/）
--
-- 决策依据：
--   - DECISIONS.md D003：复用 miniapp.characters 作为分区 A 角色卡池
--   - DECISIONS.md D010：保留在 miniapp schema（跨 schema FK 由 PG 原生支持）
--   - 新方案设计文档第 95 行：是否上下架（enabled）+ is_default + 排序
--
-- 字段语义：
--   - is_default：阶段一新用户初始化时的默认激活卡（写入 user_st_settings.settings_jsonb.active_character）
--   - enabled：是否上架（同步引擎只下发 enabled=true 的卡）
--   - sort_order：大厅展示顺序（数字越小越靠前）
--
-- 幂等性：ADD COLUMN IF NOT EXISTS（PG 9.6+ 原生支持）

ALTER TABLE miniapp.characters
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS enabled    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

-- 表注释（三标签视图，供同步引擎反向校验配置清单）
COMMENT ON TABLE miniapp.characters IS
  '[partition=A][shape=resource:platform_pool][direction=down] 平台管控的默认角色卡池。'
  '复用 miniapp schema（D003 决策），跨 schema FK 由 PG 原生支持。'
  '同步引擎下发到 ST data/<handle>/characters/platform_<id>.png（D004 资产文件稳定命名）';

COMMENT ON COLUMN miniapp.characters.is_default IS
  '新用户初始化时是否自动激活此卡（user_st_settings.settings_jsonb.active_character 取此卡的 platform_<id>）';
COMMENT ON COLUMN miniapp.characters.enabled IS
  '是否上架。同步引擎只下发 enabled=true 的卡。下架不删数据，便于回溯';
COMMENT ON COLUMN miniapp.characters.sort_order IS
  '大厅展示顺序，数字越小越靠前。同 sort_order 时按 created_at 兜底';

-- 业务约束：is_default = true 的卡全表最多 1 行（部分唯一索引）
-- 阶段一只暴露一张默认卡，未来开放会员等级时改为 (audience, is_default) 复合唯一
CREATE UNIQUE INDEX IF NOT EXISTS idx_characters_one_default
  ON miniapp.characters((1))
  WHERE is_default = true;

-- 索引：大厅按 enabled + sort_order 列表查询
CREATE INDEX IF NOT EXISTS idx_characters_enabled_sort
  ON miniapp.characters(enabled, sort_order)
  WHERE enabled = true;
