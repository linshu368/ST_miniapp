-- Local-only invite shape so 20260922_invite_first_paid_vip_fulfillment.sql can replace
-- the existing function. Never apply this file to test or production.

CREATE SCHEMA IF NOT EXISTS miniapp_traffic;

CREATE TABLE IF NOT EXISTS miniapp_traffic.invite_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_user_id UUID NOT NULL REFERENCES app_core.users(id),
  invitee_user_id UUID NOT NULL UNIQUE REFERENCES app_core.users(id),
  invite_code TEXT NOT NULL,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invite_no_self CHECK (inviter_user_id <> invitee_user_id)
);

CREATE TABLE IF NOT EXISTS miniapp_traffic.invite_reward_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relation_id UUID NOT NULL REFERENCES miniapp_traffic.invite_relations(id),
  inviter_user_id UUID NOT NULL,
  rule_key TEXT NOT NULL,
  event_ref TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invite_reward_dedup UNIQUE (relation_id, rule_key, event_ref)
);

-- 本地替身只记录一次发奖。正式库仍使用 105 的 grant_invite_reward，本文件不会被 apply。
CREATE OR REPLACE FUNCTION miniapp_traffic.grant_invite_reward(
  p_relation_id UUID,
  p_rule_key TEXT,
  p_event_ref TEXT
) RETURNS TABLE (status TEXT, credits INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_inviter UUID;
  v_inserted INTEGER;
BEGIN
  SELECT inviter_user_id INTO v_inviter
  FROM miniapp_traffic.invite_relations
  WHERE id = p_relation_id;

  INSERT INTO miniapp_traffic.invite_reward_logs (
    relation_id, inviter_user_id, rule_key, event_ref, credits
  ) VALUES (
    p_relation_id, v_inviter, p_rule_key, p_event_ref, 2000
  )
  ON CONFLICT ON CONSTRAINT invite_reward_dedup DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN QUERY SELECT 'duplicated'::TEXT, 0;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'granted'::TEXT, 2000;
END;
$$;

CREATE OR REPLACE FUNCTION miniapp_traffic.check_invite_first_paid_reward(
  p_invitee_user_id UUID,
  p_order_id TEXT
) RETURNS TABLE (status TEXT, credits INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN QUERY SELECT 'stub'::TEXT, 0;
END;
$$;
