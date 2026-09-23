-- Batch Lab：为项目 wbtsfzozlmurljvglhpn 的 PostgREST 暴露 batch_lab。
-- 本文件与 110 migration 分开执行；必须先执行 110 并人工验证 RLS/ACL。
-- 2026-09-11 只读实测基线见下方 guard。目标环境名称由部署记录明确，不能仅凭旧文件名推断。

\echo '=== guard: 必须与执行当日的完整列表一致 ==='
BEGIN;

DO $guard$
DECLARE
  v_cur TEXT;
BEGIN
  SELECT c INTO v_cur
  FROM pg_db_role_setting s
  JOIN pg_roles r ON r.oid = s.setrole
  CROSS JOIN LATERAL unnest(s.setconfig) AS u(c)
  WHERE r.rolname = 'authenticator' AND c LIKE 'pgrst.db_schemas=%';

  IF v_cur <> 'pgrst.db_schemas=graphql_public, miniapp, miniapp_analytics, miniapp_traffic, cs_platform, admin, app_core, miniapp_features, experience, billing' THEN
    RAISE EXCEPTION 'PostgREST 基线已变化（%），停止并重新盘点，禁止覆盖', v_cur;
  END IF;
  IF to_regnamespace('batch_lab') IS NULL THEN
    RAISE EXCEPTION 'batch_lab 不存在，必须先执行并验证 migration 110';
  END IF;
END
$guard$;

ALTER ROLE authenticator SET pgrst.db_schemas =
  'graphql_public, miniapp, miniapp_analytics, miniapp_traffic, cs_platform, admin, app_core, miniapp_features, experience, billing, batch_lab';

COMMIT;
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';

-- 人工 REST 验证：用 service-role + Accept-Profile: batch_lab 调用表和两个 RPC；
-- 同时回归原 10 个 schema。anon/authenticated 访问 batch_lab 表必须失败。
-- 回滚（仅回退暴露配置，不删数据）：先复核现状仍为上述 11 项，再写回 guard 中 10 项，
-- 随后依次 reload config / reload schema。