-- 013: 将已部署的「统一 st schema」原地拆分为 st_platform / st_users / st_infra（D014）
--
-- 适用场景：Supabase 上仍使用旧布局（5~6 张表都在 st.* 下），需要保留数据、不做 DROP CASCADE。
-- 全新环境请直接顺序执行 003-012，不要跑本文件。
--
-- 前置：建议先备份；在维护窗口执行（ALTER TABLE SET SCHEMA 会短暂锁表）。
-- 决策依据：DECISIONS.md D014
--
-- 搬迁后布局：
--   st_platform.platform_settings / platform_presets / platform_api_configs  （分区 A）
--   st_users.user_st_settings / user_st_chats                              （分区 B）
--   st_infra.sync_tasks                                                    （引擎基建，若存在）
--
-- 执行后：确认无 st.* 表残留 → DROP SCHEMA st（空 schema）
-- 然后：重跑 010_rls_policies.sql（幂等，刷新 RLS + schema USAGE）

-- ─── 1. 确保目标 schema 存在（与 003 一致，幂等）────────────────────────────
-- 若尚未执行过 003_create_st_schemas.sql，请先执行该文件；或在本文件之前跑一遍 003。

CREATE SCHEMA IF NOT EXISTS st_platform;
CREATE SCHEMA IF NOT EXISTS st_users;
CREATE SCHEMA IF NOT EXISTS st_infra;

REVOKE USAGE ON SCHEMA st_platform FROM public, anon, authenticated;
REVOKE USAGE ON SCHEMA st_users FROM public, anon, authenticated;
REVOKE USAGE ON SCHEMA st_infra FROM public, anon, authenticated;
GRANT USAGE ON SCHEMA st_platform TO service_role, postgres;
GRANT USAGE ON SCHEMA st_users TO service_role, postgres;
GRANT USAGE ON SCHEMA st_infra TO service_role, postgres;

-- ─── 2. 按表搬迁（仅当表仍在 st schema 时执行）────────────────────────────────
DO $migrate$
DECLARE
  moved INT := 0;
  skipped INT := 0;
  r TEXT[];
  -- (源表名, 目标 schema)
  plan TEXT[][] := ARRAY[
    ARRAY['platform_settings',    'st_platform'],
    ARRAY['platform_presets',     'st_platform'],
    ARRAY['platform_api_configs', 'st_platform'],
    ARRAY['user_st_settings',    'st_users'],
    ARRAY['user_st_chats',       'st_users'],
    ARRAY['sync_tasks',          'st_infra']
  ];
  tbl TEXT;
  dest TEXT;
BEGIN
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
  RAISE NOTICE 'D014: Migrating tables from st → st_platform / st_users / st_infra';
  RAISE NOTICE '═══════════════════════════════════════════════════════════';

  FOREACH r SLICE 1 IN ARRAY plan LOOP
    tbl := r[1];
    dest := r[2];

    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'st' AND table_name = tbl
    ) THEN
      EXECUTE format('ALTER TABLE st.%I SET SCHEMA %I', tbl, dest);
      moved := moved + 1;
      RAISE NOTICE '[MOVED] st.% → %.%', tbl, dest, tbl;
    ELSIF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = dest AND table_name = tbl
    ) THEN
      skipped := skipped + 1;
      RAISE NOTICE '[SKIP]  %.% already exists (already migrated)', dest, tbl;
    ELSE
      skipped := skipped + 1;
      RAISE WARNING '[SKIP]  st.% not found and %.% missing — run 005-012 if fresh deploy', tbl, dest, tbl;
    END IF;
  END LOOP;

  RAISE NOTICE '───────────────────────────────────────────────────────────';
  RAISE NOTICE 'Summary: % table(s) moved, % skipped', moved, skipped;
END $migrate$;

-- ─── 3. 删除空的旧 st schema（仅当其中已无用户表）────────────────────────────
DO $drop_st$
DECLARE
  remaining INT;
BEGIN
  SELECT COUNT(*) INTO remaining
  FROM information_schema.tables
  WHERE table_schema = 'st'
    AND table_type = 'BASE TABLE';

  IF remaining = 0 THEN
    DROP SCHEMA IF EXISTS st;
    RAISE NOTICE '[OK] Dropped empty schema "st"';
  ELSE
    RAISE WARNING 'Schema "st" still has % table(s) — not dropped. Inspect manually.', remaining;
  END IF;
END $drop_st$;

-- ─── 4. 验证（只读，供人工核对）──────────────────────────────────────────────
DO $verify$
DECLARE
  rec RECORD;
BEGIN
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
  RAISE NOTICE 'Post-migration table locations (st_* schemas only):';
  FOR rec IN
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema IN ('st_platform', 'st_users', 'st_infra')
    ORDER BY table_schema, table_name
  LOOP
    RAISE NOTICE '  %.%', rec.table_schema, rec.table_name;
  END LOOP;
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
  RAISE NOTICE 'Next step: re-run 010_rls_policies.sql (idempotent)';
END $verify$;
