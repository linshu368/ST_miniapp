-- 003: 创建 ST 同步层的三个 schema 并锁定 schema 级权限
--
-- 决策依据：
--   - DECISIONS.md D014：按"语义角色"切分 schema（取代 D010 的"业务/同步"二分）
--   - 三个 schema 各承担单一语义，避免 D010 时期 st schema 同时承载"分区映射 + 基建"的歧义
--   - 仍然遵守 D009 minimal RLS：service_role 唯一可访问（在 010 中应用到表级）
--
-- Schema 角色：
--   st_platform → 分区 A：平台管控数据，Supabase = 绝对真相，单向下发
--   st_users    → 分区 B：用户运行时镜像，runtime 时 ST 文件系统 = 真相源，反向镜像
--   st_infra    → 同步引擎运维基建（任务队列、未来的 audit / metrics）
--
-- 幂等性：
--   - CREATE SCHEMA IF NOT EXISTS
--   - REVOKE/GRANT 是幂等的
--   - ALTER DEFAULT PRIVILEGES 幂等
--
-- 执行后效果：
--   - 三个 schema 存在，只允许 service_role / postgres 访问
--   - anon / authenticated 无 USAGE 权限（即使后续表级 RLS 出现遗漏，schema 级 deny 兜底）

-- ─── st_platform：分区 A 平台管控 ────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS st_platform;

COMMENT ON SCHEMA st_platform IS
  'ST_miniapp 同步层 - 分区 A：平台管控数据（Supabase = 绝对真相，单向下发到 ST）。'
  '仅 service_role 可访问。决策见 DECISIONS.md D014';

REVOKE USAGE ON SCHEMA st_platform FROM public;
REVOKE USAGE ON SCHEMA st_platform FROM anon, authenticated;
GRANT USAGE ON SCHEMA st_platform TO service_role;
GRANT USAGE ON SCHEMA st_platform TO postgres;

ALTER DEFAULT PRIVILEGES IN SCHEMA st_platform REVOKE ALL ON TABLES FROM public;
ALTER DEFAULT PRIVILEGES IN SCHEMA st_platform REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA st_platform GRANT ALL ON TABLES TO service_role;

-- ─── st_users：分区 B 用户运行时镜像 ──────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS st_users;

COMMENT ON SCHEMA st_users IS
  'ST_miniapp 同步层 - 分区 B：用户运行时数据镜像（runtime 时 ST 文件系统 = 真相源，'
  '反向镜像到此 schema；跨会话 Supabase 接替成为唯一可达真相）。'
  '仅 service_role 可访问。决策见 DECISIONS.md D014';

REVOKE USAGE ON SCHEMA st_users FROM public;
REVOKE USAGE ON SCHEMA st_users FROM anon, authenticated;
GRANT USAGE ON SCHEMA st_users TO service_role;
GRANT USAGE ON SCHEMA st_users TO postgres;

ALTER DEFAULT PRIVILEGES IN SCHEMA st_users REVOKE ALL ON TABLES FROM public;
ALTER DEFAULT PRIVILEGES IN SCHEMA st_users REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA st_users GRANT ALL ON TABLES TO service_role;

-- ─── st_infra：同步引擎运维基建 ──────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS st_infra;

COMMENT ON SCHEMA st_infra IS
  'ST_miniapp 同步层 - 基建：同步引擎运维支撑（任务队列、未来的 audit / metrics 等）。'
  '不属于分区 A / B 的"用户视角数据"，是引擎自身的运维表。'
  '仅 service_role 可访问。决策见 DECISIONS.md D014';

REVOKE USAGE ON SCHEMA st_infra FROM public;
REVOKE USAGE ON SCHEMA st_infra FROM anon, authenticated;
GRANT USAGE ON SCHEMA st_infra TO service_role;
GRANT USAGE ON SCHEMA st_infra TO postgres;

ALTER DEFAULT PRIVILEGES IN SCHEMA st_infra REVOKE ALL ON TABLES FROM public;
ALTER DEFAULT PRIVILEGES IN SCHEMA st_infra REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA st_infra GRANT ALL ON TABLES TO service_role;
