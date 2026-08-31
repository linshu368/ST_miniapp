-- 空跑 099 被 preflight 拦住后的取证：查清 charge_voice_usage 以及 miniapp 是否还有其它盘点后新增对象。
-- 纯 SELECT。

\pset footer off

\echo === extra miniapp functions not in the 2026-08-25 24-fn baseline ===
SELECT p.proname AS fn,
       pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_function_result(p.oid) AS returns,
       p.prosecdef AS security_definer,
       l.lanname AS lang,
       (position('miniapp.' IN p.prosrc) > 0) AS body_refs_miniapp
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname = 'miniapp'
  AND p.proname NOT IN (
    'increment_user_total_round',
    'tf_track_character_listing',
    'claim_daily_checkin',
    'complete_wish_role',
    'create_wish_role',
    'get_character_favorite_counts',
    'list_character_favorites',
    'set_character_favorite',
    'apply_context_window_flood',
    'guard_chat_session_idle',
    'start_chat_history_regeneration',
    'start_chat_history_turn',
    'tf_refresh_chat_session_stats_from_history',
    'charge_llm_usage',
    'complete_payment_order',
    'deduct_wallet_credits',
    'expire_payment_orders',
    'finalize_character_free_chat_round',
    'grant_new_user_signup_bonus',
    'grant_wallet_on_user_insert',
    'prepare_llm_usage_charge',
    'reconcile_llm_usage',
    'reserve_character_free_chat_round',
    'retain_recent_llm_usage_charges',
    'tf_set_user_character_round'
  )
ORDER BY 1, 2;

\echo === extra miniapp relations not in the 22+1 baseline ===
SELECT c.relname AS rel, c.relkind::text AS relkind
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'miniapp'
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  AND c.relname NOT IN (
    'users', 'miniapp_user_settings', 'characters', 'runtime_config',
    'character_favorites', 'character_ranking_scores', 'daily_checkins',
    'wish_roles', 'notifications', 'notification_reads',
    'chat_sessions', 'chat_history', 'chat_message_audio', 'current_chat_history',
    'payment_orders', 'wallet_ledger', 'user_wallets',
    'llm_usage_charges', 'llm_usage_charge_dedup',
    'character_free_chat_quotas', 'character_free_chat_quota_decisions',
    'support_conversations', 'support_messages'
  )
ORDER BY 1;

\echo === charge_voice_usage full def ===
SELECT pg_get_functiondef(p.oid)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'miniapp' AND p.proname = 'charge_voice_usage';
