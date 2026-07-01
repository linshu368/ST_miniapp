-- 007: 分区 A - 平台 API 配置池（资产型，含凭证）
--
-- 分区归属：A 类（平台管控，Supabase = 绝对真相）
-- 形态：资源型-平台池（设计文档第 96 行）+ 凭证（D008）
-- 数据流：Supabase → ST（单向下发到 ST data/<handle>/secrets.json + settings.json 中的 endpoint 字段）
--
-- 决策依据：
--   - 新方案设计文档第 96 行：阶段一所有用户统一用平台 key 和 model，建表但不消费多行
--   - DECISIONS.md D008：凭证存储策略（阶段一明文 + 严格 RLS + 应用层硬约束）
--   - DECISIONS.md D008：表名 platform_api_configs（旧名 platform_api_credentials 已废弃）
--
-- 安全约束（D008）：
--   1) 阶段一存明文，阶段二切 Supabase Vault（pgsodium）
--   2) anon/authenticated 完全禁读（由 010_rls_policies.sql 强制）
--   3) 应用层硬约束：config_payload.api_key 永远不返回到客户端响应
--   4) 所有读取走同步引擎 + 进 audit log
--
-- 字段简化说明（vs 旧 platform_api_credentials）：
--   旧表把 provider / api_key / api_base_url / model_whitelist 拆成独立列；
--   新表合并为 config_payload jsonb（原则 3：jsonb 整块存）。
--   语义和投影策略不变，但减少了 schema 演进时的 ALTER TABLE 需求。

CREATE TABLE IF NOT EXISTS st_platform.platform_api_configs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 显示名（运营后台展示用，不暴露给最终用户）
  display_name        TEXT NOT NULL,

  -- 配置载荷（jsonb 整块存）
  -- 阶段一约定结构（应用层校验，DB 不约束）：
  --   {
  --     "provider": "openrouter",       // ST SECRET_KEYS 枚举对齐
  --     "api_key": "<plain text>",      // [SENSITIVE] 阶段一明文
  --     "api_base_url": "<optional>",   // 自定义代理 / 反向代理
  --     "model": "anthropic/claude-sonnet-4.5",  // 默认模型
  --     "model_whitelist": []           // 可选数组，空数组 = 不限制
  --   }
  config_payload      JSONB NOT NULL,

  -- 阶段一只激活一行（is_default=true）
  is_default          BOOLEAN NOT NULL DEFAULT false,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 约束 ────────────────────────────────────────────────────────────────
-- is_default = true 全表唯一（阶段一只激活一个 API 配置）
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_api_configs_one_default
  ON st_platform.platform_api_configs((1))
  WHERE is_default = true;

-- ─── 注释（三标签视图） ──────────────────────────────────────────────────
COMMENT ON TABLE st_platform.platform_api_configs IS
  '[partition=A][shape=resource:platform_pool][direction=down] 平台 API 配置池（含凭证）。'
  'anon/authenticated 完全禁读，仅 service_role 可访问。'
  '阶段一只激活 1 行（is_default=true），所有用户统一使用。详见 DECISIONS.md D008';

COMMENT ON COLUMN st_platform.platform_api_configs.config_payload IS
  '[SENSITIVE] 配置载荷 jsonb，包含 provider / api_key（阶段一明文）/ api_base_url / model / model_whitelist。'
  '应用层硬约束：api_key 永远不返回到客户端响应';
COMMENT ON COLUMN st_platform.platform_api_configs.is_default IS
  '是否激活。同步引擎只下发 is_default=true 的配置到 ST secrets.json + settings.json';
