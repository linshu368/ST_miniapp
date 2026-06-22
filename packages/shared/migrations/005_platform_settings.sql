-- 005: 分区 A - 平台 settings 全量快照（配置型）
--
-- 分区归属：A 类（平台管控，Supabase = 绝对真相）
-- 形态：配置型（设计文档第 70 行表格）
-- 数据流：Supabase → ST（单向下发到 ST data/<handle>/settings.json）
--
-- 决策依据：
--   - 新方案设计文档原则 2：append-only，永不原地更新
--   - 新方案设计文档原则 3：jsonb 整块存
--   - 新方案设计文档决策 2：白名单（writable_paths）和 settings 一起 append-only 冻结
--   - 新方案设计文档决策 3：白名单条目带 transform 类型
--
-- 表语义：
--   一行 = 平台运营发布的一个全局配置版本快照
--   投影到 ST：take latest by platform_version → merge(A_settings, B_settings) → settings.json
--   下发顺序见决策 5：先下发资产层，再下发配置层

CREATE TABLE IF NOT EXISTS st_platform.platform_settings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ─── 版本字段 ──────────────────────────────────────────────────────────
  -- 运营节奏的全局版本号，单调递增。投影时取 max(platform_version)
  -- 用 BIGINT 避免 INT 溢出（一年发 100 版也才 100，但用 BIGINT 不增加成本）
  platform_version    BIGINT NOT NULL,

  -- ─── 内容字段 ──────────────────────────────────────────────────────────
  -- 完整 ST settings 全量快照（jsonb 整块存，原则 3）
  settings_jsonb      JSONB NOT NULL,

  -- 白名单（决策 2 + 决策 3）：[{path, transform}, ...]
  -- 阶段一支持的 transform：
  --   - "passthrough"：不变换，原样写入
  --   - "character_ref"：值是 platform_<uuid>.png，下发时校验对应 miniapp.characters 是否存在；失效回退默认卡
  -- 未来扩展：preset_ref / world_ref / model_tier_ref（schema 字段已预留，code 未实现）
  writable_paths      JSONB NOT NULL DEFAULT '[]',

  -- ─── 元数据 ─────────────────────────────────────────────────────────────
  -- canonical hash（key 排序后 sha256），用于去重和快速比对
  -- 由应用层计算（PG 原生 jsonb canonical 序列化不稳定）
  content_hash        TEXT NOT NULL,

  -- 运营人标识（阶段一预留，可填 'system' / TG 用户名 / 内部 admin id）
  created_by          TEXT NOT NULL DEFAULT 'system',

  -- 版本说明（人读，便于运营回滚时定位）
  note                TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 约束 ────────────────────────────────────────────────────────────────
-- platform_version 全局唯一且单调递增（决策 2：append-only）
-- 注：单调递增由应用层保证（取 max + 1），此处仅强制唯一
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_settings_version
  ON st_platform.platform_settings(platform_version);

-- content_hash 跨版本唯一：同一份内容不允许写入两次（幂等保护）
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_settings_content_hash
  ON st_platform.platform_settings(content_hash);

-- 取最新版本的索引（投影时 ORDER BY platform_version DESC LIMIT 1）
CREATE INDEX IF NOT EXISTS idx_platform_settings_latest
  ON st_platform.platform_settings(platform_version DESC);

-- ─── 注释（三标签视图） ──────────────────────────────────────────────────
COMMENT ON TABLE st_platform.platform_settings IS
  '[partition=A][shape=config][direction=down] 平台 settings 全量快照 + 白名单。append-only，'
  '一行一个全局版本。下发到 ST data/<handle>/settings.json（决策 5：资产层 → 配置层顺序）';

COMMENT ON COLUMN st_platform.platform_settings.platform_version IS
  '全局单调递增版本号。投影时取 MAX(platform_version)。应用层保证递增，此处仅唯一约束';
COMMENT ON COLUMN st_platform.platform_settings.settings_jsonb IS
  'ST settings.json 全量内容（原则 3：jsonb 整块存，不拆列）';
COMMENT ON COLUMN st_platform.platform_settings.writable_paths IS
  '白名单 [{path, transform}, ...]。path 用 lodash dot-path；transform 阶段一支持 passthrough / character_ref'
  '（未来扩展 preset_ref / world_ref / model_tier_ref，schema 已预留）';
COMMENT ON COLUMN st_platform.platform_settings.content_hash IS
  'canonical hash（key 排序后 sha256），由应用层计算。同 hash 拒绝重复写入（幂等）';
