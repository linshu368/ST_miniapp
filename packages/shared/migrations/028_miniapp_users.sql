-- 028: Split MiniApp users from public.users.
--
-- This migration intentionally does not backfill historical public.users rows.
-- MiniApp user data starts fresh from miniapp.users after this migration.

CREATE TABLE IF NOT EXISTS miniapp.users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tg_id                 TEXT NOT NULL UNIQUE,
  source_id             TEXT,
  bot_entered_at        TIMESTAMPTZ,
  miniapp_entered_at    TIMESTAMPTZ,
  total_round           BIGINT NOT NULL DEFAULT 0,
  st_handle             TEXT NOT NULL UNIQUE,
  st_initialized_at     TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE miniapp.users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp.users FROM anon, authenticated;
GRANT ALL ON miniapp.users TO service_role, postgres;

COMMENT ON TABLE miniapp.users IS
  'MiniApp 独立用户身份表。从本迁移后新用户开始记录，不迁移 public.users 历史数据。';
COMMENT ON COLUMN miniapp.users.tg_id IS
  'Telegram 用户唯一标识。';
COMMENT ON COLUMN miniapp.users.source_id IS
  '用户来源渠道占位字段，当前默认 NULL。';
COMMENT ON COLUMN miniapp.users.bot_entered_at IS
  '用户首次在挂载 bot 中点击 /start 的时间，由 bot 内部接口写入。';
COMMENT ON COLUMN miniapp.users.miniapp_entered_at IS
  '用户首次进入 MiniApp 的时间，由 MiniApp 登录链路创建用户时写入。';
COMMENT ON COLUMN miniapp.users.total_round IS
  '用户使用 MiniApp 以来的总对话轮数，与 miniapp_user_settings.total_round 同步递增。';
COMMENT ON COLUMN miniapp.users.st_handle IS
  'SillyTavern 用户 handle，由 tg_id 确定性派生，对应 ST data/<handle>/ 目录。';
COMMENT ON COLUMN miniapp.users.st_initialized_at IS
  '首次 MiniApp→ST provision 完成时间，NULL 表示尚未初始化。';

-- Drop historical user-owned data that still points at public.users. Keeping
-- platform/config tables intact, but clearing rows that would violate the new
-- empty miniapp.users foreign keys. Some tables are optional across older
-- environments, so truncate only those that exist.
DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'cs_platform.outreach_messages',
    'cs_platform.outreach_sessions',
    'cs_platform.persona_member_state',
    'cs_platform.persona_member_snapshots',
    'cs_platform.audit_logs',
    'st_infra.sync_tasks',
    'st_users.user_st_chats',
    'st_users.user_st_settings',
    'miniapp.chat_history',
    'miniapp.chat_message_charges',
    'miniapp.wallet_ledger',
    'miniapp.daily_checkins',
    'miniapp.payment_orders',
    'miniapp.user_wallets',
    'miniapp.wish_roles',
    'miniapp.wish_role_sessions',
    'miniapp.miniapp_user_settings'
  ]
  LOOP
    IF to_regclass(table_name) IS NOT NULL THEN
      EXECUTE format('TRUNCATE TABLE %s', table_name);
    END IF;
  END LOOP;
END;
$$;

-- Rewire MiniApp-owned user tables.
ALTER TABLE miniapp.miniapp_user_settings
  DROP CONSTRAINT IF EXISTS miniapp_user_settings_user_id_fkey,
  ADD CONSTRAINT miniapp_user_settings_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES miniapp.users(id) ON DELETE CASCADE;

ALTER TABLE miniapp.payment_orders
  DROP CONSTRAINT IF EXISTS payment_orders_user_id_fkey,
  ADD CONSTRAINT payment_orders_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES miniapp.users(id) ON DELETE CASCADE;

ALTER TABLE miniapp.user_wallets
  DROP CONSTRAINT IF EXISTS user_wallets_user_id_fkey,
  ADD CONSTRAINT user_wallets_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES miniapp.users(id) ON DELETE CASCADE;

ALTER TABLE miniapp.wallet_ledger
  DROP CONSTRAINT IF EXISTS wallet_ledger_user_id_fkey,
  ADD CONSTRAINT wallet_ledger_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES miniapp.users(id) ON DELETE CASCADE;

ALTER TABLE miniapp.chat_message_charges
  DROP CONSTRAINT IF EXISTS chat_message_charges_user_id_fkey,
  ADD CONSTRAINT chat_message_charges_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES miniapp.users(id) ON DELETE CASCADE;

ALTER TABLE miniapp.daily_checkins
  DROP CONSTRAINT IF EXISTS daily_checkins_user_id_fkey,
  ADD CONSTRAINT daily_checkins_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES miniapp.users(id) ON DELETE CASCADE;

ALTER TABLE miniapp.wish_roles
  DROP CONSTRAINT IF EXISTS wish_roles_db_user_id_fkey,
  ADD CONSTRAINT wish_roles_db_user_id_fkey
    FOREIGN KEY (db_user_id) REFERENCES miniapp.users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF to_regclass('miniapp.wish_role_sessions') IS NOT NULL THEN
    ALTER TABLE miniapp.wish_role_sessions
      DROP CONSTRAINT IF EXISTS wish_role_sessions_db_user_id_fkey,
      ADD CONSTRAINT wish_role_sessions_db_user_id_fkey
        FOREIGN KEY (db_user_id) REFERENCES miniapp.users(id) ON DELETE CASCADE;
  END IF;
END;
$$;

ALTER TABLE miniapp.chat_history
  DROP CONSTRAINT IF EXISTS chat_history_user_id_fkey,
  ADD CONSTRAINT chat_history_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES miniapp.users(id) ON DELETE CASCADE;

-- Rewire runtime tables that store MiniApp user mirrors/tasks.
ALTER TABLE st_users.user_st_settings
  DROP CONSTRAINT IF EXISTS user_st_settings_user_id_fkey,
  ADD CONSTRAINT user_st_settings_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES miniapp.users(id) ON DELETE CASCADE;

ALTER TABLE st_users.user_st_chats
  DROP CONSTRAINT IF EXISTS user_st_chats_user_id_fkey,
  ADD CONSTRAINT user_st_chats_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES miniapp.users(id) ON DELETE CASCADE;

ALTER TABLE st_infra.sync_tasks
  DROP CONSTRAINT IF EXISTS sync_tasks_user_id_fkey,
  ADD CONSTRAINT sync_tasks_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES miniapp.users(id) ON DELETE CASCADE;

-- CS user outreach data is user-owned and starts fresh with new MiniApp users.
ALTER TABLE cs_platform.persona_member_snapshots
  DROP CONSTRAINT IF EXISTS persona_member_snapshots_user_id_fkey,
  ADD CONSTRAINT persona_member_snapshots_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES miniapp.users(id) ON DELETE CASCADE;

ALTER TABLE cs_platform.persona_member_state
  DROP CONSTRAINT IF EXISTS persona_member_state_user_id_fkey,
  ADD CONSTRAINT persona_member_state_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES miniapp.users(id) ON DELETE CASCADE;

ALTER TABLE cs_platform.outreach_sessions
  DROP CONSTRAINT IF EXISTS outreach_sessions_user_id_fkey,
  ADD CONSTRAINT outreach_sessions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES miniapp.users(id) ON DELETE CASCADE;

ALTER TABLE cs_platform.outreach_messages
  DROP CONSTRAINT IF EXISTS outreach_messages_user_id_fkey,
  ADD CONSTRAINT outreach_messages_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES miniapp.users(id) ON DELETE CASCADE;

ALTER TABLE cs_platform.audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_user_id_fkey,
  ADD CONSTRAINT audit_logs_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES miniapp.users(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION miniapp.increment_user_total_round(
  p_user_id UUID,
  p_delta INTEGER DEFAULT 1
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = miniapp, public
AS $$
BEGIN
  IF p_delta <= 0 THEN
    RETURN;
  END IF;

  UPDATE miniapp.users
  SET
    total_round = total_round + p_delta,
    updated_at = now()
  WHERE id = p_user_id;

  UPDATE miniapp.miniapp_user_settings
  SET
    total_round = total_round + p_delta,
    updated_at = now()
  WHERE user_id = p_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION miniapp.increment_user_total_round(UUID, INTEGER) TO service_role, postgres;

COMMENT ON FUNCTION miniapp.increment_user_total_round(UUID, INTEGER) IS
  '成功完成 MiniApp 对话后原子递增 miniapp.users 和 miniapp_user_settings 的 total_round。';

CREATE OR REPLACE VIEW cs_platform.user_metrics AS
WITH payment_summary AS (
  SELECT
    user_id,
    count(*) FILTER (WHERE status = 'completed')::INTEGER AS paid_count,
    COALESCE(sum(amount_cents) FILTER (WHERE status = 'completed'), 0)::INTEGER AS paid_cents
  FROM miniapp.payment_orders
  GROUP BY user_id
),
message_activity AS (
  SELECT
    user_id,
    max(created_at) AS last_message_at
  FROM miniapp.chat_history
  GROUP BY user_id
)
SELECT
  u.id AS user_id,
  u.tg_id AS telegram_user_id,
  COALESCE(NULLIF(s.display_name, ''), NULLIF(s.tg_username, ''), NULLIF(s.tg_first_name, ''), u.tg_id) AS display_name,
  s.tg_username AS username,
  GREATEST(floor(extract(epoch FROM (now() - COALESCE(u.miniapp_entered_at, u.created_at))) / 86400)::INTEGER, 0) AS register_days,
  COALESCE(w.total_paid_amount, 0)::NUMERIC(12, 2) AS total_paid_amount,
  COALESCE(p.paid_count, 0)::INTEGER AS paid_count,
  COALESCE(u.total_round, s.total_round, 0)::BIGINT AS total_round,
  COALESCE(m.last_message_at, s.updated_at, u.updated_at, u.miniapp_entered_at, u.created_at) AS last_active_at
FROM miniapp.users u
LEFT JOIN miniapp.miniapp_user_settings s ON s.user_id = u.id
LEFT JOIN miniapp.user_wallets w ON w.user_id = u.id
LEFT JOIN payment_summary p ON p.user_id = u.id
LEFT JOIN message_activity m ON m.user_id = u.id;

UPDATE cs_platform.personas
SET rule_sql = replace(rule_sql, 'FROM public.users u', 'FROM miniapp.users u');

UPDATE cs_platform.personas
SET rule_sql = replace(rule_sql, 'u.created_at', 'u.miniapp_entered_at');
