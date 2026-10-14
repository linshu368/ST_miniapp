-- 20261013: 为失败且随后被修订的迁移认领补最小恢复审计。
-- domain: supabase_migrations（平台 schema，不是八个业务域之一）
--
-- 认领行用于 SQL 已成功而账本写入失败时的同 checksum 续跑；它不是已执行账本。
-- 若迁移 SQL 在事务内失败回滚、随后需要修订文件，旧 checksum 会刻意阻止重跑。
-- 本迁移只扩展事件审计能力：执行脚本会在单一事务中复核无账本、checksum 漂移并记录原因，
-- 然后才删除旧认领；它本身不删除任何认领行。
--
-- 前置：20260910_schema_migrations_ledger.sql、20260914_repo_migration_ledger_events.sql。
-- 回滚：恢复 action CHECK 为 apply/force_rerun 并保留 details 列；已写审计事件不可安全删除。

BEGIN;

ALTER TABLE supabase_migrations.repo_migration_events
  ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE supabase_migrations.repo_migration_events
  DROP CONSTRAINT IF EXISTS repo_migration_events_action_check;

ALTER TABLE supabase_migrations.repo_migration_events
  ADD CONSTRAINT repo_migration_events_action_check
  CHECK (action IN ('apply', 'force_rerun', 'abandon_claim'));

REVOKE ALL ON supabase_migrations.repo_migration_events FROM anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'supabase_migrations'
      AND table_name = 'repo_migration_events'
      AND column_name = 'details'
      AND data_type = 'jsonb'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'postflight: repo_migration_events.details must be non-null jsonb';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'supabase_migrations.repo_migration_events'::regclass
      AND conname = 'repo_migration_events_action_check'
      AND pg_get_constraintdef(oid) LIKE '%abandon_claim%'
  ) THEN
    RAISE EXCEPTION 'postflight: repo_migration_events must allow abandon_claim audit events';
  END IF;

  IF has_table_privilege('anon', 'supabase_migrations.repo_migration_events', 'INSERT')
     OR has_table_privilege('authenticated', 'supabase_migrations.repo_migration_events', 'INSERT') THEN
    RAISE EXCEPTION 'postflight: event audit table must remain non-public';
  END IF;
END;
$$;

COMMIT;
