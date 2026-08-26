-- Schema 划分一阶段 · 批次 A 只读盘点
-- 用法：psql "$URL" -X -q -A -F '|' -f ops/schema-split/inventory.sql
-- 纯 SELECT，无任何写库动作。输出以 ===SECTION:name=== 分节，便于按节 diff。
-- 故意不加 ON_ERROR_STOP：cron 等 schema 在某一库缺失时，报错本身就是盘点结论。

\pset footer off
\set appns '\'public\',\'miniapp\',\'admin\',\'cs_platform\',\'miniapp_traffic\',\'miniapp_analytics\',\'analytics\',\'app_core\',\'miniapp_features\',\'experience\',\'billing\',\'growth\',\'miniapp_simulation\',\'st_platform\',\'st_users\',\'st_infra\''

\echo ===SECTION:00_meta===
SELECT current_database() AS db,
       split_part(version(), ' ', 2) AS server_version,
       current_user AS conn_role;

\echo ===SECTION:01_schemas_all===
SELECT n.nspname AS nsp,
       pg_get_userbyid(n.nspowner) AS nsp_owner,
       coalesce(array_to_string(n.nspacl, ' '), '(default)') AS nsp_acl
FROM pg_namespace n
WHERE n.nspname NOT LIKE 'pg\_%'
  AND n.nspname <> 'information_schema'
ORDER BY 1;

\echo ===SECTION:02_relations===
SELECT n.nspname AS nsp,
       c.relname AS rel,
       c.relkind AS relkind,
       pg_get_userbyid(c.relowner) AS rel_owner,
       c.relrowsecurity AS rls,
       c.relpersistence AS persist
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN (:appns)
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
ORDER BY 1, 3, 2;

\echo ===SECTION:03_columns===
SELECT c.table_schema AS nsp,
       c.table_name AS rel,
       c.ordinal_position AS pos,
       c.column_name AS col,
       c.data_type
         || coalesce('(' || c.character_maximum_length || ')', '')
         || coalesce('(' || c.numeric_precision || ',' || c.numeric_scale || ')', '') AS col_type,
       c.is_nullable AS col_nullable,
       coalesce(c.column_default, '') AS col_default,
       coalesce(c.is_generated, '') AS col_generated,
       coalesce(c.identity_generation, '') AS col_identity
FROM information_schema.columns c
WHERE c.table_schema IN (:appns)
ORDER BY 1, 2, 3;

\echo ===SECTION:04_functions===
SELECT n.nspname AS nsp,
       p.proname AS fn,
       pg_get_function_identity_arguments(p.oid) AS fn_args,
       pg_get_function_result(p.oid) AS fn_returns,
       p.prokind AS fn_kind,
       p.prosecdef AS security_definer,
       pg_get_userbyid(p.proowner) AS fn_owner,
       coalesce(array_to_string(p.proconfig, ' '), '') AS fn_config,
       l.lanname AS fn_lang,
       md5(p.prosrc) AS src_md5,
       (position('miniapp.' IN p.prosrc) > 0) AS body_refs_miniapp,
       coalesce(array_to_string(p.proacl, ' '), '(default)') AS fn_acl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname IN (:appns)
ORDER BY 1, 2, 3;

\echo ===SECTION:05_function_miniapp_refs===
SELECT n.nspname || '.' || p.proname AS fn,
       m[1] AS ref,
       count(*) AS hits
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace,
     LATERAL regexp_matches(p.prosrc, '(miniapp\.[a-zA-Z0-9_]+)', 'g') AS m
WHERE n.nspname IN (:appns)
GROUP BY 1, 2
ORDER BY 1, 2;

\echo ===SECTION:06_triggers===
SELECT n.nspname AS nsp,
       c.relname AS rel,
       t.tgname AS trg,
       regexp_replace(pg_get_triggerdef(t.oid), '\s+', ' ', 'g') AS trg_def,
       t.tgenabled AS trg_enabled
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal
  AND n.nspname IN (:appns)
ORDER BY 1, 2, 3;

\echo ===SECTION:07_constraints===
SELECT n.nspname AS nsp,
       c.relname AS rel,
       con.conname AS con_name,
       con.contype AS con_type,
       CASE WHEN con.confrelid <> 0
            THEN fn.nspname || '.' || fc.relname ELSE '' END AS con_refs,
       regexp_replace(pg_get_constraintdef(con.oid), '\s+', ' ', 'g') AS con_def
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_class fc ON fc.oid = con.confrelid
LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
WHERE n.nspname IN (:appns)
ORDER BY 1, 2, 4, 3;

\echo ===SECTION:08_fk_crossing===
SELECT n.nspname || '.' || c.relname AS child_rel,
       fn.nspname || '.' || fc.relname AS parent_rel,
       con.conname AS con_name,
       con.confdeltype AS on_delete
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_class fc ON fc.oid = con.confrelid
JOIN pg_namespace fn ON fn.oid = fc.relnamespace
WHERE con.contype = 'f'
  AND (n.nspname IN (:appns) OR fn.nspname IN (:appns))
  AND n.nspname <> fn.nspname
ORDER BY 1, 2, 3;

\echo ===SECTION:09_views_def===
SELECT n.nspname AS nsp,
       c.relname AS rel,
       c.relkind AS relkind,
       CASE WHEN c.reloptions IS NULL THEN '' ELSE array_to_string(c.reloptions, ' ') END AS reloptions,
       (position('miniapp.' IN pg_get_viewdef(c.oid)) > 0) AS def_refs_miniapp,
       regexp_replace(pg_get_viewdef(c.oid), '\s+', ' ', 'g') AS view_def
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN (:appns)
  AND c.relkind IN ('v', 'm')
ORDER BY 1, 2;

\echo ===SECTION:10_indexes===
SELECT schemaname AS nsp,
       tablename AS rel,
       indexname AS idx,
       regexp_replace(indexdef, '\s+', ' ', 'g') AS idx_def
FROM pg_indexes
WHERE schemaname IN (:appns)
ORDER BY 1, 2, 3;

\echo ===SECTION:11_rls_policies===
SELECT schemaname AS nsp,
       tablename AS rel,
       policyname AS pol,
       permissive AS pol_permissive,
       array_to_string(roles, ' ') AS pol_roles,
       cmd AS pol_cmd,
       coalesce(regexp_replace(qual, '\s+', ' ', 'g'), '') AS pol_using,
       coalesce(regexp_replace(with_check, '\s+', ' ', 'g'), '') AS pol_check
FROM pg_policies
WHERE schemaname IN (:appns)
ORDER BY 1, 2, 3;

\echo ===SECTION:12_table_grants===
SELECT table_schema AS nsp,
       table_name AS rel,
       grantee AS grantee,
       string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) AS privs
FROM information_schema.role_table_grants
WHERE table_schema IN (:appns)
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

\echo ===SECTION:13_default_acls===
SELECT coalesce(n.nspname, '(global)') AS nsp,
       pg_get_userbyid(d.defaclrole) AS grantor,
       d.defaclobjtype AS objtype,
       array_to_string(d.defaclacl, ' ') AS acl
FROM pg_default_acl d
LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
ORDER BY 1, 2, 3;

\echo ===SECTION:14_role_settings===
SELECT coalesce(r.rolname, '(all roles)') AS role_name,
       coalesce(d.datname, '(all dbs)') AS db_name,
       array_to_string(s.setconfig, ' || ') AS setconfig
FROM pg_db_role_setting s
LEFT JOIN pg_roles r ON r.oid = s.setrole
LEFT JOIN pg_database d ON d.oid = s.setdatabase
ORDER BY 1, 2;

\echo ===SECTION:15_publications===
SELECT p.pubname AS pubname,
       coalesce(pt.schemaname, '(none)') AS nsp,
       coalesce(pt.tablename, '(none)') AS rel
FROM pg_publication p
LEFT JOIN pg_publication_tables pt ON pt.pubname = p.pubname
ORDER BY 1, 2, 3;

\echo ===SECTION:16_types===
SELECT n.nspname AS nsp,
       t.typname AS typ,
       t.typtype AS typkind,
       pg_get_userbyid(t.typowner) AS typ_owner
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname IN (:appns)
  AND t.typtype IN ('e', 'd', 'r')
ORDER BY 1, 2;

\echo ===SECTION:17_extensions===
SELECT e.extname AS ext,
       n.nspname AS nsp,
       e.extversion AS ext_version
FROM pg_extension e
LEFT JOIN pg_namespace n ON n.oid = e.extnamespace
ORDER BY 1;

\echo ===SECTION:18_comments===
SELECT n.nspname AS nsp,
       c.relname AS rel,
       coalesce(a.attname, '(table)') AS col,
       regexp_replace(d.description, '\s+', ' ', 'g') AS cmnt
FROM pg_description d
JOIN pg_class c ON c.oid = d.objoid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid
WHERE n.nspname IN (:appns)
  AND d.classoid = 'pg_class'::regclass
ORDER BY 1, 2, 3;

\echo ===SECTION:19_sequences_owned===
SELECT sn.nspname AS seq_nsp,
       s.relname AS seq,
       tn.nspname AS owner_nsp,
       t.relname AS owner_rel,
       a.attname AS owner_col
FROM pg_depend dep
JOIN pg_class s ON s.oid = dep.objid AND s.relkind = 'S'
JOIN pg_namespace sn ON sn.oid = s.relnamespace
JOIN pg_class t ON t.oid = dep.refobjid
JOIN pg_namespace tn ON tn.oid = t.relnamespace
JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = dep.refobjsubid
WHERE dep.classid = 'pg_class'::regclass
  AND dep.refclassid = 'pg_class'::regclass
  AND dep.deptype IN ('a', 'i')
  AND (sn.nspname IN (:appns) OR tn.nspname IN (:appns))
ORDER BY 1, 2;

\echo ===SECTION:20_cron_jobs===
SELECT j.jobid AS jobid,
       j.schedule AS schedule,
       j.active AS active,
       j.database AS db_name,
       j.username AS run_as,
       regexp_replace(j.command, '\s+', ' ', 'g') AS command
FROM cron.job j
ORDER BY j.jobid;

\echo ===SECTION:21_cron_last_runs===
SELECT r.jobid AS jobid,
       max(r.start_time)::text AS last_start,
       (array_agg(r.status ORDER BY r.start_time DESC))[1] AS last_status,
       (array_agg(left(coalesce(r.return_message, ''), 120) ORDER BY r.start_time DESC))[1] AS last_message,
       count(*) AS runs_recorded
FROM cron.job_run_details r
GROUP BY r.jobid
ORDER BY r.jobid;

\echo ===SECTION:22_rowcounts===
SELECT t.table_schema AS nsp,
       t.table_name AS rel,
       (xpath('/row/c/text()',
              query_to_xml(format('SELECT count(*) AS c FROM %I.%I', t.table_schema, t.table_name),
                           false, true, '')))[1]::text::bigint AS row_count
FROM information_schema.tables t
WHERE t.table_schema IN (:appns)
  AND t.table_type = 'BASE TABLE'
ORDER BY 1, 2;

\echo ===SECTION:23_relation_sizes===
SELECT n.nspname AS nsp,
       c.relname AS rel,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
       pg_total_relation_size(c.oid) AS total_bytes
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN (:appns)
  AND c.relkind IN ('r', 'p', 'm')
ORDER BY pg_total_relation_size(c.oid) DESC;

\echo ===SECTION:24_activity===
SELECT count(*) AS active_backends,
       coalesce(max(extract(epoch FROM (now() - xact_start)))::int, 0) AS oldest_xact_seconds
FROM pg_stat_activity
WHERE state <> 'idle'
  AND pid <> pg_backend_pid();

\echo ===SECTION:END===
