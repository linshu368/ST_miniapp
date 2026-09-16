-- 20260914: 迁移账本补操作历史表与执行中认领表。
-- domain: supabase_migrations（平台 schema，不是八个业务域之一）
--
-- C：执行与记账不再分两步互斥。20260910 只建了 repo_migrations（filename PK）。
-- 本文件补两张表，db-migrate 的 apply 脚本用它们：
--   repo_migration_claims  执行中认领。Apply 成功、Record 失败时认领行还在，
--                          下次同文件续跑只补记账（SQL 仍会再执行一遍，迁移须幂等）。
--   repo_migration_events  force_rerun 的操作历史。不覆盖 repo_migrations 首次
--                          applied_at / checksum。
--
-- 前置：20260910_schema_migrations_ledger.sql（账本表必须已在）。
-- 本文件幂等，CREATE TABLE IF NOT EXISTS。
-- 执行：GitHub Actions → Database Migration，先 test 后 production。

BEGIN;

CREATE TABLE IF NOT EXISTS supabase_migrations.repo_migration_claims (
  filename text PRIMARY KEY,
  checksum text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text NOT NULL DEFAULT current_user
);

CREATE TABLE IF NOT EXISTS supabase_migrations.repo_migration_events (
  id bigserial PRIMARY KEY,
  filename text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text NOT NULL DEFAULT current_user,
  action text NOT NULL CHECK (action IN ('apply', 'force_rerun'))
);

CREATE INDEX IF NOT EXISTS repo_migration_events_filename_applied_at_idx
  ON supabase_migrations.repo_migration_events (filename, applied_at);

COMMENT ON TABLE supabase_migrations.repo_migration_claims IS
  '迁移执行中认领：Apply 与 Record 之间的缺口。成功记账后删除。不要当已执行清单用。';
COMMENT ON TABLE supabase_migrations.repo_migration_events IS
  '迁移执行历史。force_rerun 只在这里追加，不改 repo_migrations 首次记录。';

REVOKE ALL ON supabase_migrations.repo_migration_claims FROM anon, authenticated;
REVOKE ALL ON supabase_migrations.repo_migration_events FROM anon, authenticated;
REVOKE ALL ON SEQUENCE supabase_migrations.repo_migration_events_id_seq FROM anon, authenticated;

COMMIT;
