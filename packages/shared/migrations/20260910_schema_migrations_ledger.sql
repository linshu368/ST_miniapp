-- 20260910: 数据库迁移账本 supabase_migrations.schema_migrations。
-- domain: supabase_migrations（平台 schema，不是八个业务域之一）
--
-- 背景：迁移目录无 applied 记录，哪个文件在哪个库跑过全靠人记；编号撞号是惯犯
-- （021/030/031/032/053/065/086/088/092/093/095 历史撞号，100 号立「全分支唯一」规矩后
-- 105/108/109 又各撞一对）。本迁移建立账本表，db-migrate workflow 执行前查账本防重跑、
-- 执行成功后写入记录。
--
-- 放在 supabase_migrations：库里已有这个 schema，专门记迁移历史；不要占用
-- app_core（业务根域）。本表列是 filename / checksum / applied_by，和 Supabase CLI
-- 自带的 schema_migrations（version / statements / name）不是同一张表。若 CLI 表
-- 已经占了同名，本迁移会失败而不是覆盖。
--
-- 配套规则（见 migrations/README.md）：
--   1. 本文件起，新迁移一律命名 YYYYMMDD_描述.sql，日期戳 + 语义名，并行分支天然不撞号；
--   2. 账本只对本文件之后的新迁移生效，存量迁移不回填（历史已无法精确对账）；
--   3. 改库只有仓库迁移一条路：禁止用 Supabase Management API / Studio 直改表结构。
--
-- 执行：GitHub Actions → Database Migration，先 test 后 production。
-- 本文件幂等，可重复执行。若早期版本曾把表建在 app_core，会把行搬过来再删旧表。

BEGIN;

CREATE SCHEMA IF NOT EXISTS supabase_migrations;

-- CLI 若已占用同名表（有 version 列、没有 filename 列），禁止覆盖。
DO $$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'supabase_migrations'
         AND table_name = 'schema_migrations'
         AND column_name = 'filename'
     ) THEN
    RAISE EXCEPTION
      'supabase_migrations.schema_migrations 已存在且没有 filename 列（多半是 Supabase CLI 历史表），拒绝覆盖';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  filename text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text NOT NULL DEFAULT current_user
);

-- 早期草稿若已把账本建在 app_core，迁到本表后删除。
DO $$
BEGIN
  IF to_regclass('app_core.schema_migrations') IS NULL THEN
    NULL;
  ELSE
    INSERT INTO supabase_migrations.schema_migrations (filename, checksum, applied_at, applied_by)
    SELECT filename, checksum, applied_at, applied_by
    FROM app_core.schema_migrations
    ON CONFLICT (filename) DO NOTHING;
    DROP TABLE app_core.schema_migrations;
  END IF;
END $$;

COMMENT ON TABLE supabase_migrations.schema_migrations IS
  '仓库 SQL 迁移账本：db-migrate workflow 执行前查重、执行后写入。只覆盖 2026-09-10 之后的新迁移。';
COMMENT ON COLUMN supabase_migrations.schema_migrations.filename IS '迁移文件名（不含路径），如 20260910_schema_migrations_ledger.sql';
COMMENT ON COLUMN supabase_migrations.schema_migrations.checksum IS '迁移文件内容 sha256，用于发现「已执行的文件事后被改动」';
COMMENT ON COLUMN supabase_migrations.schema_migrations.applied_by IS 'workflow 传入的执行者标识（GitHub actor），本地执行时为数据库角色名';

REVOKE ALL ON supabase_migrations.schema_migrations FROM anon, authenticated;

COMMIT;
