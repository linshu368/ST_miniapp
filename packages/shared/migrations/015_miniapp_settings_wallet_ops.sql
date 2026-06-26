-- 015: MiniApp 用户设置与支付订单过期补充
--
-- 目标：
--   - MiniApp 用户设置独立落在 miniapp schema，不复用 Bot/ST settings 表
--   - pending 支付订单到期后可落库为 expired，避免只在读取时临时展示

CREATE TABLE IF NOT EXISTS miniapp.miniapp_user_settings (
  user_id                  UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  tg_username              TEXT,
  tg_first_name            TEXT,
  tg_last_name             TEXT,
  display_name             TEXT,
  avatar_url               TEXT,
  total_round              BIGINT NOT NULL DEFAULT 0,
  pref_word_count          TEXT NOT NULL DEFAULT '300-500'
                            CHECK (pref_word_count IN ('100-300', '300-500', '500-800', '800+')),
  pref_show_options        BOOLEAN NOT NULL DEFAULT true,
  pref_custom_instructions TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS miniapp.runtime_config (
  key         TEXT PRIMARY KEY,
  value       JSONB,
  description TEXT,
  version     INTEGER DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  text_value  TEXT
);

ALTER TABLE miniapp.miniapp_user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp.runtime_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp.miniapp_user_settings FROM anon, authenticated;
REVOKE ALL ON miniapp.runtime_config FROM anon, authenticated;
GRANT ALL ON miniapp.miniapp_user_settings TO service_role, postgres;
GRANT ALL ON miniapp.runtime_config TO service_role, postgres;

CREATE OR REPLACE FUNCTION miniapp.expire_payment_orders(
  p_user_id UUID DEFAULT NULL
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE miniapp.payment_orders
  SET status = 'expired'
  WHERE status = 'pending'
    AND expires_at <= now()
    AND (p_user_id IS NULL OR user_id = p_user_id);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION miniapp.expire_payment_orders(UUID) TO service_role, postgres;

COMMENT ON TABLE miniapp.miniapp_user_settings IS
  'MiniApp 独立用户设置表。与 Bot/ST settings 表隔离。';

COMMENT ON FUNCTION miniapp.expire_payment_orders(UUID) IS
  'MiniApp 支付订单过期落库函数：将已过期 pending 订单更新为 expired。';
