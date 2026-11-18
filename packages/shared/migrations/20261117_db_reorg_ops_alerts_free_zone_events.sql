-- Domain: ops（观测 O / 投递任务 J）——告警事故、告警投递、畅聊上下架事件整表迁入 ops。
-- 数据库重组阶段 2b，规则见 docs/db/CONTRACT.md §1，计划见 .trellis/tasks/11-17-db-reorg-p2-observability/design.md。
--
--   app_core.alert_incidents             -> ops.alert_incidents
--   app_core.alert_delivery_attempts     -> ops.alert_delivery_jobs（告警飞书投递 outbox，J）
--   miniapp_features.free_zone_events    -> ops.free_zone_events（只追加）
-- ALTER TABLE ... SET SCHEMA 原样搬：数据、索引、约束、序列、RLS、表授权都跟着走；
-- miniapp_analytics.free_zone_model_events 视图按 OID 引用，自动指向新位置。
-- 旧位置留同名兼容视图（security_invoker，授权与原表相同），让发布前的旧后端照常读写；
-- 后端改读 ops 并上线生产后，由阶段 2 后续 migration 删除这三个兼容视图。
-- 后端只用 Prisma 原生 SQL 访问这三张表（写死 schema 名），不经 PostgREST，ops 不需要暴露。
--
-- Verify: bash scripts/test-db-reorg-p2b-migration.sh（PG17 非超级用户：两次幂等；数据与序列随表走；
--   旧后端的 SQL（FOR UPDATE、RETURNING、ON CONFLICT、FOR UPDATE SKIP LOCKED）经兼容视图照常执行；
--   新后端的 SQL 直接读写 ops；分析视图跟随；service_role 权限不变、anon/authenticated 无权限）。
-- Release: TEST -> Production -> 后端发布（改读 ops）-> 后续 migration 删兼容视图。
-- Recovery: 兼容视图在，旧后端可直接回退；数据库回退 = 删视图后 ALTER TABLE ... SET SCHEMA 搬回原处并改回原名。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $move$
BEGIN
  IF to_regnamespace('ops') IS NULL THEN
    RAISE EXCEPTION 'schema ops missing: apply 20261117_db_reorg_ops_cs_feed.sql first';
  END IF;

  IF to_regclass('ops.alert_incidents') IS NULL THEN
    ALTER TABLE app_core.alert_incidents SET SCHEMA ops;
  END IF;
  IF to_regclass('ops.alert_delivery_jobs') IS NULL THEN
    ALTER TABLE app_core.alert_delivery_attempts SET SCHEMA ops;
    ALTER TABLE ops.alert_delivery_attempts RENAME TO alert_delivery_jobs;
  END IF;
  IF to_regclass('ops.free_zone_events') IS NULL THEN
    ALTER TABLE miniapp_features.free_zone_events SET SCHEMA ops;
  END IF;
END
$move$;

COMMENT ON TABLE ops.alert_incidents IS '告警事故（每个指纹一行）。写入方 backend/src/features/alerting。';
COMMENT ON TABLE ops.alert_delivery_jobs IS '告警飞书投递 outbox（J）。原 app_core.alert_delivery_attempts。';
COMMENT ON TABLE ops.free_zone_events IS '畅聊候选模型上架/下架/冷却事件，只追加。原 miniapp_features.free_zone_events。';

-- 兼容视图：只为发布窗口内的旧后端保留。
CREATE OR REPLACE VIEW app_core.alert_incidents WITH (security_invoker = true) AS
  SELECT * FROM ops.alert_incidents;
CREATE OR REPLACE VIEW app_core.alert_delivery_attempts WITH (security_invoker = true) AS
  SELECT * FROM ops.alert_delivery_jobs;
CREATE OR REPLACE VIEW miniapp_features.free_zone_events WITH (security_invoker = true) AS
  SELECT * FROM ops.free_zone_events;
COMMENT ON VIEW app_core.alert_incidents IS '临时兼容视图 -> ops.alert_incidents；后端切到 ops 上线后删除。';
COMMENT ON VIEW app_core.alert_delivery_attempts IS '临时兼容视图 -> ops.alert_delivery_jobs；后端切到 ops 上线后删除。';
COMMENT ON VIEW miniapp_features.free_zone_events IS '临时兼容视图 -> ops.free_zone_events；后端切到 ops 上线后删除。';

REVOKE ALL ON app_core.alert_incidents, app_core.alert_delivery_attempts, miniapp_features.free_zone_events
  FROM PUBLIC;
DO $acl$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON app_core.alert_incidents, app_core.alert_delivery_attempts, miniapp_features.free_zone_events FROM %I', v_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON app_core.alert_incidents, app_core.alert_delivery_attempts TO service_role;
    GRANT SELECT, INSERT ON miniapp_features.free_zone_events TO service_role;
  END IF;
END
$acl$;

COMMIT;
