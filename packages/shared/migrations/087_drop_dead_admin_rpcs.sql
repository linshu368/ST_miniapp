-- 087: 删除 admin schema 里 21 个零消费方的 RPC（表全部保留）。
--
-- 三类来源：
--   1) ST 预设管理（9 个）——函数体直接引用 st_platform.*，运营台对应页面已在 ST 清理中归档。
--      这批必须先于 088（DROP SCHEMA st_platform）删除，否则 drop 后会留下一堆一调就报错的函数。
--   2) 运营台数据分析（10 个）——analytics 模块已在 commit 62b4767 删除，
--      components/analytics/ 现为空目录。get_analytics_dashboard 同时引用 st_platform 与 growth。
--   3) 一次性工具与残留（2 个）——rewrite_model_catalog_is_free 是 085 的迁移工具，
--      list_character_favorite_leaderboard 从未接入前端。
--
-- 判定依据（两库实测）：应用代码全量检索零命中；库内 pg_proc.prosrc / pg_get_viewdef /
-- pg_policy / pg_constraint / pg_attrdef / pg_trigger / cron.job 全部零引用。
--
-- 【不删】admin.is_registered_admin()：盘点初稿把它列为死函数，实测它被
-- admin.admin_users 上的 RLS policy admin_users_read_self 使用
-- （USING (user_id = auth.uid() AND admin.is_registered_admin())），是活的访问控制。
-- 同理 can_access_environment / current_environment / is_managed_config_key /
-- snapshot_operator_name 也是其他 RPC 的内部依赖，均不在本清单内。
--
-- 幂等：全部 IF EXISTS，可重复执行。不使用 CASCADE——若某个函数意外仍被依赖，
-- 应当报错中止而不是把依赖方一起带走。

BEGIN;

-- 1) ST 预设管理（引用 st_platform.*）
DROP FUNCTION IF EXISTS admin.create_platform_preset(p_display_name text, p_preset_payload jsonb, p_enabled boolean, p_sort_order integer);
DROP FUNCTION IF EXISTS admin.list_platform_presets();
DROP FUNCTION IF EXISTS admin.list_platform_preset_versions(p_limit integer);
DROP FUNCTION IF EXISTS admin.list_platform_preset_model_assignments();
DROP FUNCTION IF EXISTS admin.publish_platform_preset(p_display_name text, p_preset_payload jsonb);
DROP FUNCTION IF EXISTS admin.set_platform_preset_enabled(p_preset_id uuid, p_enabled boolean);
DROP FUNCTION IF EXISTS admin.update_platform_preset_metadata(p_preset_id uuid, p_display_name text, p_sort_order integer);
DROP FUNCTION IF EXISTS admin.update_platform_preset_model_assignment(p_model_id text, p_preset_id uuid, p_expected_version bigint);
DROP FUNCTION IF EXISTS admin.update_platform_preset_model_assignments(p_preset_id uuid, p_model_ids text[], p_expected_version bigint);

-- 2) 运营台数据分析模块
--    analytics_bucket / analytics_require_access 是这一组的内部工具函数，
--    仅被本组其他函数调用，随组一起下线。
DROP FUNCTION IF EXISTS admin.get_analytics_dashboard(p_section text, p_from timestamp with time zone, p_to timestamp with time zone, p_grain text);
DROP FUNCTION IF EXISTS admin.get_analytics_chat_detail(p_chat_id uuid);
DROP FUNCTION IF EXISTS admin.get_analytics_user_detail(p_user_id uuid);
DROP FUNCTION IF EXISTS admin.list_analytics_chats(p_from timestamp with time zone, p_to timestamp with time zone, p_search text, p_status text, p_limit integer, p_offset integer);
DROP FUNCTION IF EXISTS admin.list_analytics_users(p_search text, p_limit integer, p_offset integer);
DROP FUNCTION IF EXISTS admin.list_analytics_outreach_messages(p_from timestamp with time zone, p_to timestamp with time zone, p_search text, p_status text, p_limit integer, p_offset integer);
DROP FUNCTION IF EXISTS admin.list_llm_usage_charges(p_from timestamp with time zone, p_to timestamp with time zone, p_search text, p_model text, p_fallback boolean, p_status text, p_limit integer, p_offset integer);
DROP FUNCTION IF EXISTS admin.get_llm_usage_charge_detail(p_charge_id uuid);
DROP FUNCTION IF EXISTS admin.analytics_bucket(p_timestamp timestamp with time zone, p_grain text);
DROP FUNCTION IF EXISTS admin.analytics_require_access(p_details boolean);

-- 3) 一次性工具与未接入的残留
DROP FUNCTION IF EXISTS admin.rewrite_model_catalog_is_free(p_value jsonb);
DROP FUNCTION IF EXISTS admin.list_character_favorite_leaderboard(p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer);

COMMIT;

-- 验证（执行后应返回 0 行）：
--   SELECT p.proname FROM pg_proc p
--   WHERE p.pronamespace = 'admin'::regnamespace
--     AND p.proname IN (
--       'create_platform_preset','list_platform_presets','list_platform_preset_versions',
--       'list_platform_preset_model_assignments','publish_platform_preset','set_platform_preset_enabled',
--       'update_platform_preset_metadata','update_platform_preset_model_assignment',
--       'update_platform_preset_model_assignments','get_analytics_dashboard','analytics_bucket',
--       'analytics_require_access','get_analytics_chat_detail','get_analytics_user_detail',
--       'list_analytics_chats','list_analytics_users','list_analytics_outreach_messages',
--       'list_llm_usage_charges','get_llm_usage_charge_detail','list_character_favorite_leaderboard',
--       'rewrite_model_catalog_is_free');
--
-- 回滚：21 个函数的**线上现行定义**已原样导出到
-- packages/shared/migrations/archive/087_dropped_admin_rpcs.sql，需要时直接从该文件重建。
-- 不要回头去翻历史迁移：list_character_favorite_leaderboard 根本不在任何迁移文件里
-- （直接在库里手建的），其余函数的线上定义也可能已相对 043 / 044 / 050 / 053 / 068 / 085 漂移。
