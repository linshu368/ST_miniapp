-- 20260910: 数据库迁移账本 app_core.schema_migrations。
-- domain: app_core
--
-- 背景：迁移目录无 applied 记录，哪个文件在哪个库跑过全靠人记；编号撞号是惯犯
-- （021/030/031/032/053/065/086/088/092/093/095 历史撞号，100 号立「全分支唯一」规矩后
-- 105/108/109 又各撞一对）。本迁移建立账本表，db-migrate workflow 执行前查账本防重跑、
-- 执行成功后写入记录。
--
-- 配套规则（见 migrations/README.md「文件命名规范」）：
--   1. 本文件起，新迁移一律命名 YYYYMMDD_描述.sql，日期戳 + 语义名，并行分支天然不撞号；
--   2. 账本只对本文件之后的新迁移生效，存量迁移不回填（历史已无法精确对账）；
--   3. 改库只有仓库迁移一条路：禁止用 Supabase Management API / Studio 直改表结构。
--
-- 执行：GitHub Actions → Database Migration，先 test 后 production。
-- 本文件幂等，可重复执行。

BEGIN;

CREATE TABLE IF NOT EXISTS app_core.schema_migrations (
  filename text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text NOT NULL DEFAULT current_user
);

COMMENT ON TABLE app_core.schema_migrations IS
  '迁移账本：db-migrate workflow 执行前查重、执行后写入。只覆盖 2026-09-10 之后的新迁移。';
COMMENT ON COLUMN app_core.schema_migrations.filename IS '迁移文件名（不含路径），如 20260910_schema_migrations_ledger.sql';
COMMENT ON COLUMN app_core.schema_migrations.checksum IS '迁移文件内容 sha256，用于发现「已执行的文件事后被改动」';
COMMENT ON COLUMN app_core.schema_migrations.applied_by IS 'workflow 传入的执行者标识（GitHub actor），本地执行时为数据库角色名';

-- 与其他 app_core 表一致：仅服务端角色可访问，前端/PostgREST 不暴露
REVOKE ALL ON app_core.schema_migrations FROM anon, authenticated;

COMMIT;
