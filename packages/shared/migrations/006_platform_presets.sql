-- 006: 分区 A - 平台 API 预设池（资产型）
--
-- 分区归属：A 类（平台管控，Supabase = 绝对真相）
-- 形态：资源型-平台池（设计文档第 95 行）
-- 数据流：Supabase → ST（单向下发到 ST data/<handle>/OpenAI Settings/）
--
-- 决策依据：
--   - 新方案设计文档第 5 章：阶段一只放 1 行默认预设，所有用户统一使用
--   - 新方案设计文档决策 4：资产文件用 platform_<uuid>.json 稳定命名
--   - 新方案设计文档决策 5：先下发资产层，再下发配置层

CREATE TABLE IF NOT EXISTS st_platform.platform_presets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 显示名（运营后台 / 大厅展示）
  -- 注意：落盘文件名用 platform_<id>.json，不用 display_name（决策 4 稳定命名）
  display_name        TEXT NOT NULL,

  -- 完整预设内容（ST OpenAI Settings/<file>.json 格式）
  preset_payload      JSONB NOT NULL,

  -- ─── 平台管控字段 ─────────────────────────────────────────────────────
  is_default          BOOLEAN NOT NULL DEFAULT false,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  enabled             BOOLEAN NOT NULL DEFAULT true,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 约束 ────────────────────────────────────────────────────────────────
-- is_default = true 全表唯一（阶段一只暴露一个默认预设）
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_presets_one_default
  ON st_platform.platform_presets((1))
  WHERE is_default = true;

-- 大厅 / 同步引擎按 enabled + sort_order 列出
CREATE INDEX IF NOT EXISTS idx_platform_presets_enabled_sort
  ON st_platform.platform_presets(enabled, sort_order)
  WHERE enabled = true;

-- ─── 注释（三标签视图） ──────────────────────────────────────────────────
COMMENT ON TABLE st_platform.platform_presets IS
  '[partition=A][shape=resource:platform_pool][direction=down] 平台 API 预设池。'
  '阶段一只放 1 行默认预设。落盘文件名 platform_<id>.json（决策 4 稳定命名）';

COMMENT ON COLUMN st_platform.platform_presets.display_name IS
  '运营展示名。注意：落盘文件名用 platform_<id>.json，不用此字段（决策 4 稳定命名）';
COMMENT ON COLUMN st_platform.platform_presets.preset_payload IS
  'ST 预设 JSON 全量内容，下发时直接写入 OpenAI Settings/platform_<id>.json';
COMMENT ON COLUMN st_platform.platform_presets.is_default IS
  '新用户初始化时默认激活的预设（user_st_settings.settings_jsonb.preset_settings_openai 取此预设的 platform_<id>）';
COMMENT ON COLUMN st_platform.platform_presets.enabled IS
  '是否上架。同步引擎只下发 enabled=true 的预设';
