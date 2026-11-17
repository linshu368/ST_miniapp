-- domain: billing, miniapp_features, admin. No operational values are changed here.
-- Test before production; deploy consumers before publishing mixed config via mijing-admin.
-- Restore previous config first. Keep these columns/functions for in-flight mixed orders.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE billing.payment_orders ADD COLUMN IF NOT EXISTS vip_bonus_main_credits integer NOT NULL DEFAULT 0
  CONSTRAINT payment_orders_vip_main_reward_check CHECK (vip_bonus_main_credits BETWEEN 0 AND 1000000
    AND (product_type = 'vip' OR vip_bonus_main_credits = 0)
    AND (product_id IS DISTINCT FROM 'week' OR vip_bonus_main_credits = 0));
ALTER TABLE billing.vip_purchase_grants ADD COLUMN IF NOT EXISTS bonus_main_credits integer NOT NULL DEFAULT 0
  CONSTRAINT vip_purchase_grants_main_reward_check CHECK (bonus_main_credits BETWEEN 0 AND 1000000
    AND (plan_id <> 'week' OR bonus_main_credits = 0));

-- Callers own account/order locks and idempotency; both wallet components share their transaction.
CREATE OR REPLACE FUNCTION billing.grant_vip_reward(
  p_user_id uuid, p_bonus numeric, p_main numeric, p_entry_type text,
  p_reference_type text, p_reference_id text, p_metadata jsonb,
  OUT o_ledger_id uuid, OUT o_wallet billing.user_wallets
) LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE v_grant record;
BEGIN
  IF p_user_id IS NULL OR p_bonus IS NULL OR p_main IS NULL OR p_bonus < 0 OR p_main < 0
     OR p_bonus + p_main <= 0 OR p_bonus > 1000000 OR p_main > 1000000
     OR trunc(p_bonus) <> p_bonus OR trunc(p_main) <> p_main
     OR p_entry_type IS NULL OR p_entry_type NOT IN ('checkin_bonus', 'vip_bonus')
     OR p_reference_type IS NULL OR p_reference_id IS NULL THEN
    RAISE EXCEPTION 'Invalid VIP reward' USING ERRCODE = '22023';
  END IF;
  IF p_bonus > 0 THEN
    SELECT * INTO v_grant
    FROM billing.grant_bonus_credits(p_user_id, p_bonus, p_entry_type, p_reference_type,
      p_reference_id, p_metadata);
    o_ledger_id := v_grant.o_ledger_id;
    o_wallet := v_grant.o_wallet;
  END IF;
  IF p_main > 0 THEN
    INSERT INTO billing.user_wallets(user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
    UPDATE billing.user_wallets SET main_credits = main_credits + p_main, updated_at = now()
      WHERE user_id = p_user_id RETURNING * INTO o_wallet;
    -- Finish the new, uncommitted ledger in this transaction. The existing unique
    -- VIP order key remains one row, carrying both deltas and the final balances.
    IF p_bonus > 0 THEN
      UPDATE billing.wallet_ledger SET amount = p_bonus + p_main, main_delta = p_main,
        balance_main = o_wallet.main_credits, balance_bonus = o_wallet.bonus_credits
      WHERE id = o_ledger_id AND user_id = p_user_id;
    ELSE
    INSERT INTO billing.wallet_ledger(user_id, entry_type, amount, main_delta, bonus_delta,
      balance_main, balance_bonus, reference_type, reference_id, metadata)
    VALUES(p_user_id, p_entry_type, p_main, p_main, 0, o_wallet.main_credits,
      o_wallet.bonus_credits, p_reference_type, p_reference_id,
      COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('wallet_kind', 'main'))
    RETURNING id INTO o_ledger_id;
    END IF;
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION billing.grant_vip_reward(uuid,numeric,numeric,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION billing.grant_vip_reward(uuid,numeric,numeric,text,text,text,jsonb) TO postgres,service_role;

CREATE OR REPLACE FUNCTION admin.validate_vip_checkin_bonus_config(p_value jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $fn$
DECLARE v_bonus integer; v_main integer;
BEGIN
  IF jsonb_typeof(p_value) = 'number' THEN
    PERFORM admin.assert_vip_json_int(p_value, 0, 1000000, 'vip_checkin_bonus_config');
  ELSE
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'object'
       OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_value) key)
         IS DISTINCT FROM ARRAY['bonus_credits','main_credits'] THEN
      RAISE EXCEPTION 'Expected VIP checkin wallet split' USING ERRCODE = '22023';
    END IF;
    v_bonus := admin.assert_vip_json_int(p_value->'bonus_credits',0,1000000,'checkin.bonus_credits');
    v_main := admin.assert_vip_json_int(p_value->'main_credits',0,1000000,'checkin.main_credits');
    IF v_bonus + v_main > 1000000 THEN RAISE EXCEPTION 'VIP checkin total exceeds limit' USING ERRCODE='22023'; END IF;
  END IF;
END;
$fn$;

DO $patch$
DECLARE d text; a text; b text;
BEGIN
  d := replace(pg_get_functiondef('admin.validate_vip_plan_terms(jsonb,text)'::regprocedure), E'\r\n', E'\n');
  a := $old$ARRAY['badge_text','bonus_credits','description','duration_days','price_cents','title'] THEN$old$;
  b := $new$ARRAY['badge_text','bonus_credits','description','duration_days','price_cents','title']
     AND v_keys IS DISTINCT FROM ARRAY['badge_text','bonus_credits','bonus_main_credits','description','duration_days','price_cents','title'] THEN$new$;
  IF array_length(string_to_array(d,a),1) <> 2 THEN RAISE EXCEPTION 'Unexpected admin.validate_vip_plan_terms(jsonb,text) anchor 0'; END IF;
  d := replace(d,a,b);
  a := $old$  IF p_id = 'week' AND v_bonus <> 0 THEN$old$;
  b := $new$  PERFORM admin.assert_vip_json_int(COALESCE(p_plan->'bonus_main_credits','0'::jsonb), 0, 1000000, p_id || '.bonus_main_credits');
  IF p_id = 'week' AND (v_bonus <> 0 OR COALESCE((p_plan->>'bonus_main_credits')::integer,0) <> 0) THEN$new$;
  IF array_length(string_to_array(d,a),1) <> 2 THEN RAISE EXCEPTION 'Unexpected admin.validate_vip_plan_terms(jsonb,text) anchor 1'; END IF;
  d := replace(d,a,b);
  EXECUTE d;
END;
$patch$;

DO $patch$
DECLARE d text; a text; b text;
BEGIN
  d := replace(pg_get_functiondef('miniapp_features.claim_daily_checkin(uuid)'::regprocedure), E'\r\n', E'\n');
  a := $old$  v_total integer;$old$;
  b := $new$  v_total integer;
  v_main integer := 0;$new$;
  IF array_length(string_to_array(d,a),1) <> 2 THEN RAISE EXCEPTION 'Unexpected miniapp_features.claim_daily_checkin(uuid) anchor 0'; END IF;
  d := replace(d,a,b);
  a := $old$  IF v_vip_config IS NULL
     OR jsonb_typeof(v_vip_config) IS DISTINCT FROM 'number'
     OR (v_vip_config #>> '{}') !~ '^[0-9]+$'
     OR char_length(v_vip_config #>> '{}') > 7 THEN
    v_fallback := true;
    v_vip_credits := 90;
  ELSE
    v_vip_credits := (v_vip_config #>> '{}')::integer;
    IF v_vip_credits < 0 OR v_vip_credits > 1000000 THEN
      v_fallback := true;
      v_vip_credits := 90;
    END IF;
  END IF;

$old$;
  b := $new$  BEGIN
    PERFORM admin.validate_vip_checkin_bonus_config(v_vip_config);
    IF jsonb_typeof(v_vip_config) = 'number' THEN
      v_vip_credits := (v_vip_config #>> '{}')::integer;
    ELSE
      v_main := CASE WHEN v_vip_active THEN (v_vip_config->>'main_credits')::integer ELSE 0 END;
      v_vip_credits := (v_vip_config->>'bonus_credits')::integer + (v_vip_config->>'main_credits')::integer;
    END IF;
  EXCEPTION WHEN invalid_parameter_value THEN
    v_fallback := true;
    v_vip_credits := 150;
    v_main := 0;
  END;

$new$;
  IF strpos(d,a)=0 THEN a := replace(a, 'v_vip_credits := 90;', 'v_vip_credits := 150;'); END IF;
  IF array_length(string_to_array(d,a),1) <> 2 THEN RAISE EXCEPTION 'Unexpected miniapp_features.claim_daily_checkin(uuid) anchor 1'; END IF;
  d := replace(d,a,b);
  a := $old$FROM billing.grant_bonus_credits(
    p_user_id,
    v_total,$old$;
  b := $new$FROM billing.grant_vip_reward(
    p_user_id,
    v_total - v_main,
    v_main,$new$;
  IF array_length(string_to_array(d,a),1) <> 2 THEN RAISE EXCEPTION 'Unexpected miniapp_features.claim_daily_checkin(uuid) anchor 2'; END IF;
  d := replace(d,a,b);
  a := $old$      'reward_credits', v_total,$old$;
  b := $new$      'reward_credits', v_total,
      'main_reward_credits', v_main,
      'bonus_reward_credits', v_total - v_main,$new$;
  IF array_length(string_to_array(d,a),1) <> 2 THEN RAISE EXCEPTION 'Unexpected miniapp_features.claim_daily_checkin(uuid) anchor 3'; END IF;
  d := replace(d,a,b);
  EXECUTE d;
END;
$patch$;

DO $patch$
DECLARE d text; a text; b text;
BEGIN
  d := replace(pg_get_functiondef('billing.complete_payment_order(text,text,text)'::regprocedure), E'\r\n', E'\n');
  a := $old$  v_bonus INTEGER;$old$;
  b := $new$  v_bonus INTEGER;
  v_bonus_main INTEGER;$new$;
  IF array_length(string_to_array(d,a),1) <> 2 THEN RAISE EXCEPTION 'Unexpected billing.complete_payment_order(text,text,text) anchor 0'; END IF;
  d := replace(d,a,b);
  a := $old$  v_bonus := COALESCE(v_order.vip_bonus_credits, 0);$old$;
  b := $new$  v_bonus := COALESCE(v_order.vip_bonus_credits, 0);
  v_bonus_main := v_order.vip_bonus_main_credits;$new$;
  IF array_length(string_to_array(d,a),1) <> 2 THEN RAISE EXCEPTION 'Unexpected billing.complete_payment_order(text,text,text) anchor 1'; END IF;
  d := replace(d,a,b);
  a := $old$     OR (v_plan_id = 'week' AND v_bonus <> 0) THEN$old$;
  b := $new$     OR v_bonus_main < 0 OR v_bonus_main > 1000000
     OR (v_plan_id = 'week' AND (v_bonus <> 0 OR v_bonus_main <> 0)) THEN$new$;
  IF array_length(string_to_array(d,a),1) <> 2 THEN RAISE EXCEPTION 'Unexpected billing.complete_payment_order(text,text,text) anchor 2'; END IF;
  d := replace(d,a,b);
  a := $old$    bonus_credits,
    previous_valid_until,$old$;
  b := $new$    bonus_credits,
    bonus_main_credits,
    previous_valid_until,$new$;
  IF array_length(string_to_array(d,a),1) <> 2 THEN RAISE EXCEPTION 'Unexpected billing.complete_payment_order(text,text,text) anchor 3'; END IF;
  d := replace(d,a,b);
  a := $old$    v_bonus,
    v_previous_until,$old$;
  b := $new$    v_bonus,
    v_bonus_main,
    v_previous_until,$new$;
  IF array_length(string_to_array(d,a),1) <> 2 THEN RAISE EXCEPTION 'Unexpected billing.complete_payment_order(text,text,text) anchor 4'; END IF;
  d := replace(d,a,b);
  a := $old$  IF v_bonus > 0 THEN
    PERFORM billing.grant_bonus_credits($old$;
  b := $new$  IF v_bonus + v_bonus_main > 0 THEN
    PERFORM billing.grant_vip_reward($new$;
  IF array_length(string_to_array(d,a),1) <> 2 THEN RAISE EXCEPTION 'Unexpected billing.complete_payment_order(text,text,text) anchor 5'; END IF;
  d := replace(d,a,b);
  a := $old$      v_bonus,
      'vip_bonus',$old$;
  b := $new$      v_bonus,
      v_bonus_main,
      'vip_bonus',$new$;
  IF array_length(string_to_array(d,a),1) <> 2 THEN RAISE EXCEPTION 'Unexpected billing.complete_payment_order(text,text,text) anchor 6'; END IF;
  d := replace(d,a,b);
  EXECUTE d;
END;
$patch$;

NOTIFY pgrst, 'reload schema';
COMMIT;
