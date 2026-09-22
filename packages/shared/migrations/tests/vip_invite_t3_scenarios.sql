-- Local regression for VIP-aware invite first-paid. Throwaway database only.

CREATE SCHEMA IF NOT EXISTS vip_t3_invite;

CREATE OR REPLACE FUNCTION vip_t3_invite.assert(p_ok BOOLEAN, p_msg TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT COALESCE(p_ok, false) THEN
    RAISE EXCEPTION 'T3 invite scenario failed: %', p_msg;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION vip_t3_invite.run()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_inviter UUID := '00000000-0000-4000-8000-000000000801';
  v_vip UUID := '00000000-0000-4000-8000-000000000802';
  v_credits UUID := '00000000-0000-4000-8000-000000000803';
  v_second UUID := '00000000-0000-4000-8000-000000000804';
  v_none UUID := '00000000-0000-4000-8000-000000000805';
  v_pending UUID := '00000000-0000-4000-8000-000000000806';
  v_legacy UUID := '00000000-0000-4000-8000-000000000807';
  v_status TEXT;
  v_credits_out INTEGER;
  v_count INTEGER;
BEGIN
  INSERT INTO app_core.users (id)
  VALUES (v_inviter), (v_vip), (v_credits), (v_second), (v_none), (v_pending), (v_legacy)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO miniapp_traffic.invite_relations (inviter_user_id, invitee_user_id, invite_code)
  VALUES
    (v_inviter, v_vip, 'VIPFIRST'),
    (v_inviter, v_credits, 'CRFIRST'),
    (v_inviter, v_second, 'SECOND'),
    (v_inviter, v_pending, 'PENDING'),
    (v_inviter, v_legacy, 'LEGACY');

  INSERT INTO billing.payment_orders (
    id, user_id, status, payment_type, amount_cents, credits_amount, bonus_credits, expires_at,
    credits_added, product_type, product_id, vip_duration_days, vip_bonus_credits, fulfillment_applied
  ) VALUES
    ('INVITE_VIP_1', v_vip, 'completed', 'wxpay', 1399, 0, 0, now(), false, 'vip', 'week', 7, 0, true),
    ('INVITE_CREDITS_1', v_credits, 'completed', 'wxpay', 600, 600, 0, now(), true, 'credits', 'plan-entry', NULL, NULL, true),
    ('INVITE_PRIOR_CREDITS', v_second, 'completed', 'wxpay', 600, 600, 0, now(), true, 'credits', 'plan-entry', NULL, NULL, true),
    ('INVITE_LATER_VIP', v_second, 'completed', 'wxpay', 2888, 0, 0, now(), false, 'vip', 'month', 31, 3000, true),
    ('INVITE_PENDING_VIP', v_pending, 'pending', 'wxpay', 1399, 0, 0, now(), false, 'vip', 'week', 7, 0, false),
    ('INVITE_LEGACY_CREDITS', v_legacy, 'completed', 'wxpay', 600, 600, 0, now(), true, 'credits', 'plan-entry', NULL, NULL, false);

  SELECT c.status, c.credits INTO v_status, v_credits_out
  FROM miniapp_traffic.check_invite_first_paid_reward(v_vip, 'INVITE_VIP_1') AS c;
  PERFORM vip_t3_invite.assert(v_status = 'granted' AND v_credits_out = 2000, 'vip first cash payment grants');

  SELECT c.status INTO v_status
  FROM miniapp_traffic.check_invite_first_paid_reward(v_vip, 'INVITE_VIP_1') AS c;
  PERFORM vip_t3_invite.assert(v_status = 'duplicated', 'same vip order replay does not grant again');
  SELECT count(*) INTO v_count
  FROM miniapp_traffic.invite_reward_logs AS l
  JOIN miniapp_traffic.invite_relations AS r ON r.id = l.relation_id
  WHERE r.invitee_user_id = v_vip AND l.rule_key = 'invitee_first_paid';
  PERFORM vip_t3_invite.assert(v_count = 1, 'vip replay keeps one reward log');

  SELECT c.status INTO v_status
  FROM miniapp_traffic.check_invite_first_paid_reward(v_credits, 'INVITE_CREDITS_1') AS c;
  PERFORM vip_t3_invite.assert(v_status = 'granted', 'credits first payment still grants');

  SELECT c.status INTO v_status
  FROM miniapp_traffic.check_invite_first_paid_reward(v_second, 'INVITE_LATER_VIP') AS c;
  PERFORM vip_t3_invite.assert(v_status = 'not_first_paid', 'vip after an earlier cash payment is not first');
  SELECT count(*) INTO v_count
  FROM miniapp_traffic.invite_reward_logs AS l
  JOIN miniapp_traffic.invite_relations AS r ON r.id = l.relation_id
  WHERE r.invitee_user_id = v_second;
  PERFORM vip_t3_invite.assert(v_count = 0, 'not-first vip does not write a reward log');

  SELECT c.status INTO v_status
  FROM miniapp_traffic.check_invite_first_paid_reward(v_pending, 'INVITE_PENDING_VIP') AS c;
  PERFORM vip_t3_invite.assert(v_status = 'not_settled', 'unfulfilled vip is not settled');

  SELECT c.status INTO v_status
  FROM miniapp_traffic.check_invite_first_paid_reward(v_none, 'INVITE_MISSING') AS c;
  PERFORM vip_t3_invite.assert(v_status = 'no_relation', 'user without invite relation');

  SELECT c.status INTO v_status
  FROM miniapp_traffic.check_invite_first_paid_reward(v_legacy, 'INVITE_LEGACY_CREDITS') AS c;
  PERFORM vip_t3_invite.assert(v_status = 'granted', 'legacy credits_added order still counts');

  PERFORM vip_t3_invite.assert(
    NOT has_function_privilege('anon', 'miniapp_traffic.check_invite_first_paid_reward(uuid,text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'miniapp_traffic.check_invite_first_paid_reward(uuid,text)', 'EXECUTE')
    AND has_function_privilege('service_role', 'miniapp_traffic.check_invite_first_paid_reward(uuid,text)', 'EXECUTE'),
    'invite function execute grants'
  );

  RETURN 'vip t3 invite scenarios passed';
END;
$$;

SELECT vip_t3_invite.run();
