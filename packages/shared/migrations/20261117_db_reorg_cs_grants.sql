-- Domain: 外部读者授权（cs_feed / miniapp_analytics 视图层）。
-- 数据库重组阶段 1c：客服仓库已改读 cs_feed（ST_cs_platform 91c9593），收回客服账号对业务表的直接读权限。
-- 规则见 docs/db/CONTRACT.md §2.6，计划见 .trellis/tasks/11-17-db-reorg-p1-foundation/design.md 1c。
--
--   1) cs_runtime_v1：撤销 app_core / billing / experience 的表权限与 schema USAGE，只留 cs（自有）+ cs_feed。
--      cs.conversations / cs.campaign_targets 到 app_core.users 的外键检查以表所有者身份执行，不受影响。
--   2) cs_persona_reader（画像簇圈人 SQL）：撤销所有业务 schema，只留 cs_feed + miniapp_analytics。
--      所有者确认旧画像簇可直接丢弃，不改写。
--   3) cs_outreach_reader_v1：两个仓库零引用、无连接、不拥有对象，撤销全部权限后删除。
--
-- Verify: bash scripts/test-db-reorg-p1c-migration.sh（PG17：两次幂等、客服角色读业务表被拒、读视图正常、
--   经外键写客服表正常、遗留角色已删除、角色不存在的环境安全跳过）。
-- Release: 客服仓库改读 cs_feed 上线之后 -> TEST -> Production。
-- Recovery: 按 ST_cs_platform db/migrations/009、016 的 GRANT 语句重新授权；遗留角色无需恢复。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $grants$
DECLARE
  v_schema text;
  v_owned int;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cs_runtime_v1') THEN
    FOREACH v_schema IN ARRAY ARRAY['app_core', 'billing', 'experience'] LOOP
      IF to_regnamespace(v_schema) IS NOT NULL THEN
        EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM cs_runtime_v1', v_schema);
        EXECUTE format('REVOKE USAGE ON SCHEMA %I FROM cs_runtime_v1', v_schema);
      END IF;
    END LOOP;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cs_persona_reader') THEN
    FOREACH v_schema IN ARRAY ARRAY['app_core', 'billing', 'experience', 'miniapp_features', 'miniapp_traffic',
                                    'media_plaza', 'admin', 'ops'] LOOP
      IF to_regnamespace(v_schema) IS NOT NULL THEN
        EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM cs_persona_reader', v_schema);
        EXECUTE format('REVOKE USAGE ON SCHEMA %I FROM cs_persona_reader', v_schema);
      END IF;
    END LOOP;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cs_outreach_reader_v1') THEN
    SELECT (SELECT count(*) FROM pg_class WHERE relowner = r.oid)
         + (SELECT count(*) FROM pg_proc WHERE proowner = r.oid)
         + (SELECT count(*) FROM pg_namespace WHERE nspowner = r.oid)
      INTO v_owned
    FROM pg_roles r WHERE r.rolname = 'cs_outreach_reader_v1';
    IF v_owned > 0 THEN
      RAISE EXCEPTION 'cs_outreach_reader_v1 owns % object(s); refuse to DROP OWNED', v_owned;
    END IF;
    -- 不拥有对象时 DROP OWNED 只撤销它在本库的全部权限。
    EXECUTE 'DROP OWNED BY cs_outreach_reader_v1';
    EXECUTE 'DROP ROLE cs_outreach_reader_v1';
  END IF;
END $grants$;

COMMIT;
