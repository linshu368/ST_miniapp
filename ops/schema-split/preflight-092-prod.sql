-- 092 生产补执行前的只读核对（迁移文件头部第 16–28 行要求的三条）
-- 预期只命中 miniapp.tf_set_user_character_round 与 miniapp.current_chat_history。
-- 多出任何一个对象即停止，不得执行 092。
\pset footer off

\echo ===092PRE:functions_referencing_dead_columns===
SELECT n.nspname || '.' || p.proname AS fn,
       pg_get_function_identity_arguments(p.oid) AS fn_args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND p.prosrc ~ '(user_character_round|preset_id|llm_model_markup)'
ORDER BY 1, 2;

\echo ===092PRE:views_referencing_dead_columns===
SELECT n.nspname || '.' || c.relname AS rel,
       c.relkind AS relkind
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('v', 'm')
  AND pg_get_viewdef(c.oid) ~ '(user_character_round|preset_id|llm_model_markup)'
ORDER BY 1;

\echo ===092PRE:cron_referencing_dead_columns===
SELECT jobid,
       regexp_replace(command, '\s+', ' ', 'g') AS command
FROM cron.job
WHERE command ~ '(user_character_round|preset_id|llm_model_markup)'
ORDER BY jobid;

\echo ===092PRE:indexes_referencing_dead_columns===
SELECT schemaname || '.' || indexname AS idx,
       regexp_replace(indexdef, '\s+', ' ', 'g') AS idx_def
FROM pg_indexes
WHERE indexdef ~ '(user_character_round|preset_id|llm_model_markup)'
ORDER BY 1;

\echo ===092PRE:constraints_referencing_dead_columns===
SELECT n.nspname || '.' || c.relname AS rel,
       con.conname AS con_name,
       regexp_replace(pg_get_constraintdef(con.oid), '\s+', ' ', 'g') AS con_def
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE pg_get_constraintdef(con.oid) ~ '(user_character_round|preset_id|llm_model_markup)'
ORDER BY 1, 2;

\echo ===092PRE:current_chat_history_def===
SELECT array_to_string(c.reloptions, ' ') AS reloptions,
       coalesce(array_to_string(c.relacl, ' '), '(default)') AS acl,
       obj_description(c.oid, 'pg_class') AS cmnt,
       regexp_replace(pg_get_viewdef(c.oid), '\s+', ' ', 'g') AS view_def
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'miniapp' AND c.relname = 'current_chat_history';

\echo ===092PRE:dead_column_nonnull_counts===
SELECT count(*) AS total_rows,
       count(preset_id) AS preset_id_nonnull,
       count(llm_model_markup) AS llm_model_markup_nonnull,
       count(user_character_round) AS user_character_round_nonnull
FROM miniapp.chat_history;

\echo ===092PRE:blocking_activity===
SELECT count(*) AS non_idle_backends,
       coalesce(max(extract(epoch FROM (now() - xact_start)))::int, 0) AS oldest_xact_seconds,
       coalesce(string_agg(DISTINCT left(coalesce(query, ''), 60), ' | '), '') AS sample_queries
FROM pg_stat_activity
WHERE state <> 'idle'
  AND pid <> pg_backend_pid()
  AND datname = current_database();

\echo ===092PRE:END===
