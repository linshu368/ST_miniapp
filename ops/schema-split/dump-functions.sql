-- 导出库内函数完整定义，供 migration 093 改写函数体时逐个比对。
-- 用法：psql "$URL" -X -q -t -A -f ops/schema-split/dump-functions.sql > snapshot.sql
\pset footer off

SELECT '-- ==================== '
       || n.nspname || '.' || p.proname
       || '(' || pg_get_function_identity_arguments(p.oid) || ')'
       || ' ====================' || E'\n'
       || pg_get_functiondef(p.oid) || E'\n'
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('miniapp', 'admin', 'cs_platform', 'miniapp_traffic',
                    'miniapp_analytics', 'public', 'analytics')
  AND p.prokind IN ('f', 'p')
ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid);
