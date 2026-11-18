-- Domain: 外部读者授权（cs_feed / miniapp_analytics 视图层）。
-- 取代 20261117_db_reorg_cs_grants.sql 在生产的执行：该文件用 DROP OWNED BY 撤销遗留角色权限，
-- 生产的 postgres 不是超级用户、也不是该角色成员（只有 ADMIN），报 permission denied to drop objects，
-- 整个事务回滚、未生效。原文件已在 TEST 记账，按账本规则不改旧文件，改用本文件；生产不再执行原文件。
--
-- 内容与原文件相同，只把遗留角色的撤权改为：按 pg_shdepend 逐项 REVOKE（表/视图/序列、schema、数据库），
-- 断言再无依赖后 DROP ROLE（postgres 对该角色有 ADMIN，可删除）。
--   1) cs_runtime_v1：只留 cs（自有）与 cs_feed。
--   2) cs_persona_reader：只留 cs_feed 与 miniapp_analytics。
--   3) cs_outreach_reader_v1：零引用、无连接、不拥有对象，撤权后删除。
--
-- Verify: bash scripts/test-db-reorg-p1c-migration.sh（以非超级用户 + CREATEROLE 的账号执行，与生产 postgres 同权）。
-- Release: Production 先 abandon_claim 原文件的失败认领，再执行本文件；TEST 也执行本文件（角色不存在，跳过）。
-- Recovery: 按 ST_cs_platform db/migrations/009、016 的 GRANT 语句重新授权；遗留角色无需恢复。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $grants$
DECLARE
  v_schema text;
  v_role oid;
  v_owned int;
  v_dep record;
  v_left text;
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

  SELECT oid INTO v_role FROM pg_roles WHERE rolname = 'cs_outreach_reader_v1';
  IF v_role IS NOT NULL THEN
    SELECT (SELECT count(*) FROM pg_class WHERE relowner = v_role)
         + (SELECT count(*) FROM pg_proc WHERE proowner = v_role)
         + (SELECT count(*) FROM pg_namespace WHERE nspowner = v_role)
      INTO v_owned;
    IF v_owned > 0 THEN
      RAISE EXCEPTION 'cs_outreach_reader_v1 owns % object(s); refuse to drop', v_owned;
    END IF;

    FOR v_dep IN
      SELECT d.classid, d.objid FROM pg_shdepend d
      WHERE d.refobjid = v_role AND d.deptype = 'a'
        AND (d.dbid = 0 OR d.dbid = (SELECT oid FROM pg_database WHERE datname = current_database()))
    LOOP
      IF v_dep.classid = 'pg_class'::regclass THEN
        EXECUTE format('REVOKE ALL ON TABLE %s FROM cs_outreach_reader_v1', v_dep.objid::regclass);
      ELSIF v_dep.classid = 'pg_namespace'::regclass THEN
        EXECUTE format('REVOKE ALL ON SCHEMA %I FROM cs_outreach_reader_v1', v_dep.objid::regnamespace);
      ELSIF v_dep.classid = 'pg_database'::regclass THEN
        EXECUTE format('REVOKE ALL ON DATABASE %I FROM cs_outreach_reader_v1',
                       (SELECT datname FROM pg_database WHERE oid = v_dep.objid));
      ELSIF v_dep.classid = 'pg_proc'::regclass THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM cs_outreach_reader_v1', v_dep.objid::regprocedure);
      END IF;
    END LOOP;

    SELECT string_agg(d.classid::regclass::text || ':' || d.objid, ', ') INTO v_left
    FROM pg_shdepend d WHERE d.refobjid = v_role AND d.deptype <> 'o';
    IF v_left IS NOT NULL THEN
      RAISE EXCEPTION 'cs_outreach_reader_v1 still has dependencies: %', v_left;
    END IF;
    EXECUTE 'DROP ROLE cs_outreach_reader_v1';
  END IF;
END $grants$;

COMMIT;
