-- 只读探测：库内「数据里存的 SQL / 配置文本」是否引用 miniapp.*
-- 这类引用不在 pg_proc.prosrc 或 pg_get_viewdef 里，schema 搬迁不会自动跟随，
-- 必须在 099 里显式处理，否则搬完当场坏在运行时。
\pset footer off

\echo ===DATAREF:cs_platform_personas===
SELECT id::text AS persona_id,
       name,
       (sql_text ~* 'miniapp\.') AS sql_refs_miniapp,
       left(regexp_replace(sql_text, '\s+', ' ', 'g'), 240) AS sql_head
FROM cs_platform.personas
ORDER BY name;

\echo ===DATAREF:runtime_config===
SELECT key,
       left(regexp_replace(value::text, '\s+', ' ', 'g'), 200) AS val_head
FROM miniapp.runtime_config
WHERE value::text ~* 'miniapp\.'
ORDER BY key;

\echo ===DATAREF:admin_config_drafts===
SELECT count(*) AS drafts_refs_miniapp
FROM admin.config_drafts
WHERE value::text ~* 'miniapp\.';

\echo ===DATAREF:admin_config_releases===
SELECT count(*) AS releases_refs_miniapp
FROM admin.config_releases
WHERE value::text ~* 'miniapp\.';

\echo ===DATAREF:text_value_columns===
SELECT 'miniapp.runtime_config.text_value' AS src, count(*) AS refs_miniapp
FROM miniapp.runtime_config WHERE text_value ~* 'miniapp\.'
UNION ALL
SELECT 'admin.config_drafts.text_value', count(*)
FROM admin.config_drafts WHERE text_value ~* 'miniapp\.'
UNION ALL
SELECT 'admin.config_releases.text_value', count(*)
FROM admin.config_releases WHERE text_value ~* 'miniapp\.'
UNION ALL
SELECT 'cs_platform.personas.opening_script', count(*)
FROM cs_platform.personas WHERE opening_script ~* 'miniapp\.'
UNION ALL
SELECT 'cs_platform.personas.sop', count(*)
FROM cs_platform.personas WHERE sop::text ~* 'miniapp\.'
UNION ALL
SELECT 'cs_platform.persona_refresh_runs.sql_text', count(*)
FROM cs_platform.persona_refresh_runs WHERE sql_text ~* 'miniapp\.'
ORDER BY 1;

\echo ===DATAREF:audit_logs_schema_name===
SELECT schema_name, count(*) AS rows
FROM admin.audit_logs
GROUP BY 1 ORDER BY 2 DESC;

\echo ===DATAREF:validate_persona_sql_body===
SELECT regexp_replace(p.prosrc, '\s+', ' ', 'g') AS src
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'cs_platform'
  AND p.proname IN ('validate_persona_sql', 'normalize_persona_sql')
ORDER BY p.proname;

\echo ===DATAREF:END===
