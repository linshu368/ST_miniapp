-- 010: 阶段一 RLS 策略（minimal 模式）
--
-- 策略：所有 ST_miniapp 同步相关表全部锁死，service_role 唯一可读写
--   - anon / authenticated 角色完全禁止访问（不写任何 policy + REVOKE 表级权限）
--   - service_role 天然 BYPASSRLS，无需 policy 即可访问
--   - postgres 角色（Prisma 后端用）同样 BYPASSRLS，现有 backend 不受影响
--
-- 表清单（共 6 张，跨四个 schema）：
--   分组 1（schema=st_platform，3 张，分区 A 平台管控）：
--     - st_platform.platform_settings        （A 类配置型）
--     - st_platform.platform_presets         （A 类资产型）
--     - st_platform.platform_api_configs     （A 类资产型，含凭证）
--   分组 2（schema=st_users，2 张，分区 B 用户镜像）：
--     - st_users.user_st_settings            （B 类配置型）
--     - st_users.user_st_chats               （B 类资产型，占位）
--   分组 3（schema=miniapp，1 张，运营业务复用）：
--     - miniapp.characters                   （A 类资产型，复用 D003 决策）
--
-- 注意：st_infra.sync_tasks 的 RLS 在 012_sync_tasks.sql 中独立设置（建表即锁），
--       不进本文件的 targets 数组。
--
-- 兼容性确认：
--   - 现有 frontend 不直连 Supabase（已 grep 验证 packages/frontend/src 无 supabase 客户端）
--   - 所有 API 都走 backend → Prisma → DATABASE_URL（postgres 用户），绕过 RLS
--   - 锁死 miniapp.characters 不会破坏现有大厅
--
-- 防御性设计：
--   - 对每张目标表先检查存在性，缺失则 SKIP 并 RAISE WARNING（不再硬失败）
--   - 全文幂等可重跑
--   - 每张表独立处理，部分缺失不影响其他表
--
-- 决策依据：DECISIONS.md D008（凭证）+ D009（minimal RLS）+ D010（双 schema）+ D014（三 schema 切分）

-- ─── 主块：对三组目标表统一应用 minimal RLS 策略 ──────────────────────────────
DO $rls_apply$
DECLARE
  ok_count    INT := 0;
  skip_count  INT := 0;
  -- 用 (schema, table) 二元组数组承载 6 张表
  targets     TEXT[][] := ARRAY[
    ARRAY['st_platform', 'platform_settings'],
    ARRAY['st_platform', 'platform_presets'],
    ARRAY['st_platform', 'platform_api_configs'],
    ARRAY['st_users',    'user_st_settings'],
    ARRAY['st_users',    'user_st_chats'],
    ARRAY['miniapp',     'characters']
  ];
  i INT;
  s TEXT;
  t TEXT;
BEGIN
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
  RAISE NOTICE 'Applying minimal RLS to ST sync tables (D014 schema layout)';
  RAISE NOTICE '  Group 1 (st_platform.*): 3 tables (partition A)';
  RAISE NOTICE '  Group 2 (st_users.*):    2 tables (partition B)';
  RAISE NOTICE '  Group 3 (miniapp.*):     1 table  (characters, D003 reuse)';
  RAISE NOTICE '═══════════════════════════════════════════════════════════';

  FOR i IN 1..array_length(targets, 1) LOOP
    s := targets[i][1];
    t := targets[i][2];

    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = s AND table_name = t
    ) THEN
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', s, t);
      EXECUTE format('REVOKE ALL ON %I.%I FROM anon, authenticated', s, t);
      EXECUTE format('GRANT ALL ON %I.%I TO service_role', s, t);

      ok_count := ok_count + 1;
      RAISE NOTICE '[OK]   %.% — RLS enabled, anon/authenticated revoked, service_role granted', s, t;
    ELSE
      skip_count := skip_count + 1;
      RAISE WARNING '[SKIP] %.% does not exist — run the earlier migration first', s, t;
    END IF;
  END LOOP;

  RAISE NOTICE '───────────────────────────────────────────────────────────';
  RAISE NOTICE 'Summary: % applied, % skipped (total target: %)',
    ok_count, skip_count, array_length(targets, 1);

  IF skip_count > 0 THEN
    RAISE WARNING '⚠️  % table(s) missing. Run the missing migrations and re-run 010 (idempotent).', skip_count;
  ELSE
    RAISE NOTICE '✓ All target tables protected.';
  END IF;
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
END $rls_apply$;

-- ─── Schema 级权限兜底（D014 - 三 schema 默认权限） ─────────────────────────────
-- 即使表级权限已锁死，schema 级 USAGE 缺失会导致更早一层 deny（更严格）
-- 003_create_st_schemas.sql 已做过此操作，这里幂等重做作为防回归
DO $schema_acl$
DECLARE
  -- miniapp 也需要 USAGE，否则 service_role 无法查 miniapp.characters
  schemas TEXT[] := ARRAY['st_platform', 'st_users', 'st_infra', 'miniapp'];
  s TEXT;
BEGIN
  FOREACH s IN ARRAY schemas LOOP
    IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = s) THEN
      EXECUTE format('REVOKE USAGE ON SCHEMA %I FROM public', s);
      EXECUTE format('REVOKE USAGE ON SCHEMA %I FROM anon, authenticated', s);
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO service_role', s);
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO postgres', s);
      RAISE NOTICE '[OK] schema "%" USAGE locked to service_role/postgres only', s;
    ELSE
      RAISE WARNING '[SKIP] schema "%" does not exist — run 003_create_st_schemas.sql first', s;
    END IF;
  END LOOP;
END $schema_acl$;

-- ─── 清理可能遗留的允许 anon/authenticated 的 policy（幂等保护） ────────────────
DO $rls_cleanup$
DECLARE
  pol RECORD;
  drop_count INT := 0;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE (
      (schemaname = 'st_platform' AND tablename IN (
        'platform_settings',
        'platform_presets',
        'platform_api_configs'
      ))
      OR (schemaname = 'st_users' AND tablename IN (
        'user_st_settings',
        'user_st_chats'
      ))
      OR (schemaname = 'miniapp' AND tablename = 'characters')
    )
    AND ('anon' = ANY(roles) OR 'authenticated' = ANY(roles) OR 'public' = ANY(roles))
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
                   pol.policyname, pol.schemaname, pol.tablename);
    drop_count := drop_count + 1;
    RAISE NOTICE '[CLEANUP] Dropped policy % on %.%',
                 pol.policyname, pol.schemaname, pol.tablename;
  END LOOP;

  IF drop_count = 0 THEN
    RAISE NOTICE '[CLEANUP] No residual policies to drop. Minimal mode is clean.';
  END IF;
END $rls_cleanup$;

-- ─── 注释：未来阶段二开放部分表给 authenticated 直读的入口 ────────────────────
-- 当 PostMessage 接入 + 前端需要直读某些 platform_* 表时（如大厅展示）：
--   1) GRANT USAGE ON SCHEMA st_platform TO authenticated（如果是 st_platform 的表）
--   2) CREATE POLICY ... FOR SELECT TO authenticated USING (enabled = true);
--   3) 同步在 DECISIONS.md 补对应决策
