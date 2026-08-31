-- 099 设计取证：确认改写范围没有漏掉任何 schema，以及有无物化视图/默认权限这类
-- 「不随 OID 跟随」的对象。纯 SELECT。
-- 用法：psql "$URL" -X -q -A -F '|' -f ops/schema-split/probe-099-preflight-facts.sql

\pset footer off

\echo ===F1:函数体引用 miniapp. 的 schema 分布（全库，排除系统 schema）===
SELECT n.nspname AS nsp, count(*) AS fns
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\_%'
  AND p.prosrc ~ 'miniapp\.'
GROUP BY 1
ORDER BY 1;

\echo ===F2:全库物化视图（SET SCHEMA 后需 REFRESH 判断）===
SELECT n.nspname || '.' || c.relname AS matview
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'm'
  AND n.nspname NOT LIKE 'pg\_%'
ORDER BY 1;

\echo ===F3:miniapp_analytics 内的基表（视图之外的东西）===
SELECT c.relname AS rel, c.relkind::text AS relkind
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'miniapp_analytics'
  AND c.relkind IN ('r', 'p')
ORDER BY 1;

\echo ===F4:pg_default_acl（新建 schema 不会继承，需显式对齐）===
SELECT coalesce(n.nspname, '(global)') AS nsp,
       pg_get_userbyid(d.defaclrole) AS grantor,
       d.defaclobjtype::text AS objtype,
       array_to_string(d.defaclacl, ' ') AS acl
FROM pg_default_acl d
LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
ORDER BY 1, 2, 3;

\echo ===F5:miniapp schema 自身的 ACL 与 owner（新 schema 照它复制）===
SELECT n.nspname AS nsp,
       pg_get_userbyid(n.nspowner) AS nsp_owner,
       coalesce(array_to_string(n.nspacl, ' '), '(default)') AS nsp_acl
FROM pg_namespace n
WHERE n.nspname IN ('miniapp', 'admin', 'cs_platform', 'miniapp_traffic', 'miniapp_analytics')
ORDER BY 1;

\echo ===F6:待搬 22 表 + 1 视图的 owner 与 RLS（应全为 postgres / RLS off）===
SELECT pg_get_userbyid(c.relowner) AS rel_owner,
       c.relkind::text AS relkind,
       c.relrowsecurity AS rls,
       count(*) AS objs
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'miniapp'
  AND c.relkind IN ('r', 'v')
GROUP BY 1, 2, 3
ORDER BY 1, 2;

\echo ===F7:指向 miniapp 表的外部 FK（跨 schema，搬迁后应自动跟随）===
SELECT cn.nspname || '.' || c.relname AS child_rel,
       fn.nspname || '.' || fc.relname AS parent_rel,
       con.conname AS con_name
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace cn ON cn.oid = c.relnamespace
JOIN pg_class fc ON fc.oid = con.confrelid
JOIN pg_namespace fn ON fn.oid = fc.relnamespace
WHERE con.contype = 'f'
  AND cn.nspname <> fn.nspname
  AND (cn.nspname = 'miniapp' OR fn.nspname = 'miniapp')
ORDER BY 1, 2;

\echo ===F8:cron.job 命令里引用 miniapp 的（仅生产有 pg_cron）===
SELECT jobid, active::text, regexp_replace(command, '\s+', ' ', 'g') AS command
FROM cron.job
WHERE command ~ 'miniapp'
ORDER BY jobid;

\echo ===F9:序列的 owner 表（SET SCHEMA 表时序列是否自动跟随）===
SELECT sn.nspname AS seq_nsp, s.relname AS seq,
       tn.nspname AS owner_nsp, t.relname AS owner_rel
FROM pg_depend dep
JOIN pg_class s ON s.oid = dep.objid AND s.relkind = 'S'
JOIN pg_namespace sn ON sn.oid = s.relnamespace
JOIN pg_class t ON t.oid = dep.refobjid
JOIN pg_namespace tn ON tn.oid = t.relnamespace
WHERE dep.classid = 'pg_class'::regclass
  AND dep.refclassid = 'pg_class'::regclass
  AND dep.deptype IN ('a', 'i')
  AND (sn.nspname = 'miniapp' OR tn.nspname = 'miniapp')
ORDER BY 1, 2;

\echo ===F10:miniapp 下的自定义类型/域（SET SCHEMA 不会带走，需单独处理）===
SELECT t.typname AS typ, t.typtype::text AS typkind
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'miniapp'
  AND t.typtype IN ('e', 'd', 'r', 'c')
  AND NOT EXISTS (
    SELECT 1 FROM pg_class c WHERE c.reltype = t.oid AND c.relkind IN ('r', 'v', 'm', 'S')
  )
ORDER BY 1;

\echo ===F11:publication 是否按表列出 miniapp（搬迁后成员关系按 OID 跟随）===
SELECT p.pubname, p.puballtables::text AS all_tables,
       coalesce(count(pt.tablename) FILTER (WHERE pt.schemaname = 'miniapp'), 0) AS miniapp_tables
FROM pg_publication p
LEFT JOIN pg_publication_tables pt ON pt.pubname = p.pubname
GROUP BY 1, 2
ORDER BY 1;

\echo ===END===
