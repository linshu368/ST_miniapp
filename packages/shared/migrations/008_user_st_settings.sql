-- 008: 分区 B - 用户 ST settings 镜像（配置型，append-only）
--
-- 分区归属：B 类（用户运行时数据，runtime 时 ST 文件系统 = 真相源；跨会话 Supabase 接替）
-- 形态：配置型（设计文档第 102 行）
-- 数据流：ST 文件系统 → Supabase（异步镜像，反向同步）
--   下次登录时：Supabase → ST 投影（merge(A_settings, B_settings) → settings.json）
--
-- 决策依据：
--   - 新方案设计文档原则 2：append-only，永不原地更新
--   - 新方案设计文档原则 5：白名单是写入时的强约束，B 表只存白名单子集
--   - 新方案设计文档决策 1：B 类只存白名单子集（lodash.pick 后入库）
--   - 新方案设计文档决策 6：防抖 + content_hash 去重
--   - 新方案设计文档决策 7：A→B 字段提升的懒初始化（不批量回填）
--
-- 表语义：
--   一行 = 用户在 ST 中实际改动后被反向同步引擎入库的一个版本快照
--   只包含基于 based_on_platform_version 的白名单子集
--
-- 注意（Q3 已确认）：
--   阶段一不放 had_invalid_ref 字段。该字段的语义是"投影下发时是否打补丁"，
--   属于"投影日志"领域，与 B 表（反向镜像）方向相反。等真要做投影日志时再加。

CREATE TABLE IF NOT EXISTS st_users.user_st_settings (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ─── 用户身份 ──────────────────────────────────────────────────────────
  user_id                     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- 用户内自增版本号（同一 user_id 下单调递增），由应用层取 max + 1
  user_revision               INTEGER NOT NULL,

  -- ─── 内容字段 ──────────────────────────────────────────────────────────
  -- 仅白名单子集（决策 1：lodash.pick(settings, whitelist) 后入库）
  -- B 类语义自洽性：表里出现的每一个键 = 用户在该版本白名单下被授权改过
  settings_jsonb              JSONB NOT NULL,

  -- ─── 版本溯源 ─────────────────────────────────────────────────────────
  -- 该次镜像基于哪个 A 版本（决策 2：白名单和默认值绑在一起冻结，
  -- 所以 based_on_platform_version 同时也是 whitelist_version。
  -- Q3 已确认：阶段一不冗余 whitelist_version 字段）
  based_on_platform_version   BIGINT NOT NULL,

  -- canonical hash（key 排序后 sha256），由应用层计算，用于幂等去重（决策 6）
  content_hash                TEXT NOT NULL,

  -- ─── 元数据 ────────────────────────────────────────────────────────────
  -- 写入来源：'st_watch'（ST 文件 watch 触发）/ 'init'（首次初始化）/ 'manual'（运维手动）
  source                      TEXT NOT NULL DEFAULT 'st_watch',

  -- 多分组（设计文档原则 7：阶段一预留，不消费）
  audience                    TEXT NOT NULL DEFAULT 'default',

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 约束 ────────────────────────────────────────────────────────────────
-- 1) 同一用户的 user_revision 必须唯一（append-only 内部一致性）
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_st_settings_user_revision
  ON st_users.user_st_settings(user_id, user_revision);

-- 2) 同一用户的 content_hash 必须唯一（决策 6：幂等去重，相同内容拒绝重复入库）
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_st_settings_user_hash
  ON st_users.user_st_settings(user_id, content_hash);

-- 3) 投影时按 user_id 取最新行（ORDER BY created_at DESC LIMIT 1）
CREATE INDEX IF NOT EXISTS idx_user_st_settings_latest
  ON st_users.user_st_settings(user_id, created_at DESC);

-- ─── 注释（三标签视图） ──────────────────────────────────────────────────
COMMENT ON TABLE st_users.user_st_settings IS
  '[partition=B][shape=config][direction=up] 用户 ST settings 反向镜像（append-only）。'
  '只存白名单子集（决策 1）。结构与 platform_settings 同构。'
  '投影时取最新一行 + based_on_platform_version 对应的 A 行做 merge';

COMMENT ON COLUMN st_users.user_st_settings.settings_jsonb IS
  '白名单子集（决策 1：lodash.pick(settings, whitelist) 后入库）。'
  '语义自洽：表里有什么键 = 用户在该版本白名单下被授权改过的事实';
COMMENT ON COLUMN st_users.user_st_settings.based_on_platform_version IS
  '基于哪个 platform_settings.platform_version 镜像。'
  '由于决策 2 白名单和默认值绑定，此字段同时承担 whitelist_version 的语义';
COMMENT ON COLUMN st_users.user_st_settings.content_hash IS
  'canonical hash（key 排序后 sha256），由应用层计算。'
  '同 user_id 下同 hash 拒绝重复写入（决策 6 幂等去重）';
COMMENT ON COLUMN st_users.user_st_settings.source IS
  '写入来源：st_watch（文件 watch）/ init（初始化）/ manual（运维）';
COMMENT ON COLUMN st_users.user_st_settings.audience IS
  '多分组预留（原则 7）。阶段一统一为 default，不消费';
