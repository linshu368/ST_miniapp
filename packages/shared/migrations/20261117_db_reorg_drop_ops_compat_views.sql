-- Domain: ops——删除 2b 留下的三个临时兼容视图。
-- 数据库重组阶段 2b 收尾，计划见 .trellis/tasks/11-17-db-reorg-p2-observability/design.md 2b。
--
-- 前置：20261117_db_reorg_ops_alerts_free_zone_events.sql 已执行；生产后端已发布改读 ops（#879，11-17），
-- 并核对旧表名 SQL 在 pg_stat_statements 中不再增长。
-- 删除：app_core.alert_incidents、app_core.alert_delivery_attempts、miniapp_features.free_zone_events 三个视图。
-- 守卫：旧名若仍是表（2b 未执行）则拒绝；视图之上若还有别的视图依赖，DROP VIEW（不带 CASCADE）会报错回滚。
--
-- Verify: bash scripts/test-db-reorg-p2b-migration.sh（末段：两次幂等删除、ops 表与数据不受影响、旧名是表时拒绝）。
-- Release: TEST -> Production。无应用代码改动。
-- Recovery: 重新创建同名视图即可（定义见 20261117_db_reorg_ops_alerts_free_zone_events.sql）。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'app_core.alert_incidents', 'app_core.alert_delivery_attempts', 'miniapp_features.free_zone_events'
  ] LOOP
    IF to_regclass(v_name) IS NOT NULL
       AND (SELECT relkind FROM pg_class WHERE oid = to_regclass(v_name)) <> 'v' THEN
      RAISE EXCEPTION '% is still a table; apply 20261117_db_reorg_ops_alerts_free_zone_events.sql first', v_name;
    END IF;
  END LOOP;
  IF to_regclass('ops.alert_incidents') IS NULL OR to_regclass('ops.alert_delivery_jobs') IS NULL
     OR to_regclass('ops.free_zone_events') IS NULL THEN
    RAISE EXCEPTION 'ops tables missing';
  END IF;
END
$guard$;

DROP VIEW IF EXISTS app_core.alert_incidents;
DROP VIEW IF EXISTS app_core.alert_delivery_attempts;
DROP VIEW IF EXISTS miniapp_features.free_zone_events;

COMMIT;
