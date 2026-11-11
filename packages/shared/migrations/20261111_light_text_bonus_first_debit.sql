-- 20261111_light_text_bonus_first_debit.sql
-- domain: billing
--
-- 轻量文本模型：专项星尘（bonus_credits）优先消耗，不足部分再扣通用星尘（main_credits）。
-- 此前 main_then_bonus 是先通用后专项，导致用户买来的通用星尘被轻量模型消耗，
-- 专项星尘（只能给轻量模型用）反而闲置。
--
-- 只改 billing.apply_wallet_debit 里 main_then_bonus 的拆分顺序；其余逻辑与
-- 20260921_wallet_debit_refund.sql 逐字一致。策略标识符保持 'main_then_bonus' 不变：
--   * charge_llm_usage 的取值校验、在途快照、待恢复的同步扣款都还写着这个字符串，
--     保持不变才能让在途扣款也按新顺序走，不出现新旧顺序混用的窗口；
--   * 该字符串自本迁移起的含义是「轻量文本的组合扣款：专项优先」。
-- 不影响：main_only（标准/旗舰/图片/语音）、余额不足整笔失败、debit_key 幂等、
--   原路退款（按流水里记录的 main/bonus 数额还原，与扣款顺序无关）、创作者分成（按消耗额算）。
-- 历史流水不改写：以 main_delta / bonus_delta 为准，metadata 里的 policy 字符串不能用来推断顺序。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF to_regprocedure('billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '20261111_light_text_bonus_first_debit: run 20260921_wallet_debit_refund.sql first';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION billing.apply_wallet_debit(
  p_user_id UUID,
  p_debit_key TEXT,
  p_policy TEXT,
  p_amount NUMERIC,
  p_entry_type TEXT,
  p_reference_type TEXT,
  p_reference_id TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_wallet billing.user_wallets;
  v_existing billing.wallet_ledger;
  v_amount NUMERIC(14,1);
  v_main NUMERIC(14,1);
  v_bonus NUMERIC(14,1);
  v_ledger_id UUID;
  v_debit_key TEXT;
  v_reference_id TEXT;
BEGIN
  v_debit_key := btrim(COALESCE(p_debit_key, ''));
  v_reference_id := btrim(COALESCE(p_reference_id, v_debit_key));
  v_amount := round(COALESCE(p_amount, 0), 1);

  IF p_user_id IS NULL OR v_debit_key = '' OR v_reference_id = '' THEN
    RAISE EXCEPTION 'INVALID_AMOUNT'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_amount <= 0 OR v_amount <> trunc(v_amount) THEN
    RAISE EXCEPTION 'INVALID_AMOUNT'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_policy IS NULL OR p_policy NOT IN ('main_only', 'main_then_bonus') THEN
    RAISE EXCEPTION 'UNSUPPORTED_WALLET_POLICY'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_entry_type IS NULL OR p_entry_type NOT IN ('chat_debit', 'image_generation') THEN
    RAISE EXCEPTION 'INVALID_AMOUNT'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_reference_type IS NULL OR btrim(p_reference_type) = '' THEN
    RAISE EXCEPTION 'INVALID_AMOUNT'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO billing.user_wallets (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT *
  INTO v_wallet
  FROM billing.user_wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  SELECT *
  INTO v_existing
  FROM billing.wallet_ledger
  WHERE debit_key = v_debit_key;

  IF FOUND THEN
    IF v_existing.user_id IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION 'INVALID_AMOUNT'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'status', 'already_debited',
      'debit_key', v_debit_key,
      'ledger_id', v_existing.id,
      'wallet', to_jsonb(v_wallet),
      'split', jsonb_build_object(
        'policy', p_policy,
        'main_credits', abs(v_existing.main_delta),
        'bonus_credits', abs(v_existing.bonus_delta),
        'total_credits', abs(v_existing.amount)
      )
    );
  END IF;

  IF p_policy = 'main_only' THEN
    IF v_wallet.main_credits < v_amount THEN
      RAISE EXCEPTION 'MAIN_CREDITS_INSUFFICIENT'
        USING ERRCODE = 'P0001';
    END IF;
    v_main := v_amount;
    v_bonus := 0;
  ELSE
    IF (v_wallet.main_credits + v_wallet.bonus_credits) < v_amount THEN
      RAISE EXCEPTION 'TOTAL_CREDITS_INSUFFICIENT'
        USING ERRCODE = 'P0001';
    END IF;
    -- 专项星尘（bonus）优先，不足部分再扣通用星尘（main）。
    v_bonus := LEAST(v_wallet.bonus_credits, v_amount);
    v_main := v_amount - v_bonus;
  END IF;

  IF v_main + v_bonus <> v_amount THEN
    RAISE EXCEPTION 'INVALID_WALLET_SPLIT'
      USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    UPDATE billing.user_wallets
    SET
      main_credits = billing.user_wallets.main_credits - v_main,
      bonus_credits = billing.user_wallets.bonus_credits - v_bonus,
      updated_at = now()
    WHERE user_id = p_user_id
    RETURNING * INTO v_wallet;

    INSERT INTO billing.wallet_ledger (
      user_id,
      entry_type,
      amount,
      main_delta,
      bonus_delta,
      balance_main,
      balance_bonus,
      reference_type,
      reference_id,
      metadata,
      debit_key
    ) VALUES (
      p_user_id,
      p_entry_type,
      -v_amount,
      -v_main,
      -v_bonus,
      v_wallet.main_credits,
      v_wallet.bonus_credits,
      btrim(p_reference_type),
      v_reference_id,
      COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
        'policy', p_policy,
        'debit_key', v_debit_key
      ),
      v_debit_key
    )
    RETURNING id INTO v_ledger_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT *
      INTO v_existing
      FROM billing.wallet_ledger
      WHERE debit_key = v_debit_key;
      IF NOT FOUND OR v_existing.user_id IS DISTINCT FROM p_user_id THEN
        RAISE EXCEPTION 'INVALID_AMOUNT'
          USING ERRCODE = 'P0001';
      END IF;
      SELECT * INTO v_wallet FROM billing.user_wallets WHERE user_id = p_user_id;
      RETURN jsonb_build_object(
        'ok', true,
        'status', 'already_debited',
        'debit_key', v_debit_key,
        'ledger_id', v_existing.id,
        'wallet', to_jsonb(v_wallet),
        'split', jsonb_build_object(
          'policy', p_policy,
          'main_credits', abs(v_existing.main_delta),
          'bonus_credits', abs(v_existing.bonus_delta),
          'total_credits', abs(v_existing.amount)
        )
      );
  END;

  RETURN jsonb_build_object(
    'ok', true,
    'status', 'debited',
    'debit_key', v_debit_key,
    'ledger_id', v_ledger_id,
    'wallet', to_jsonb(v_wallet),
    'split', jsonb_build_object(
      'policy', p_policy,
      'main_credits', v_main,
      'bonus_credits', v_bonus,
      'total_credits', v_amount
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION billing.apply_wallet_debit(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.apply_wallet_debit(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, JSONB)
  TO postgres, service_role;

COMMENT ON FUNCTION billing.apply_wallet_debit(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, JSONB) IS
  '内部统一扣款。main_only / main_then_bonus（轻量文本，专项星尘优先，不足再扣通用）；余额不足整笔失败；debit_key 幂等。仅 service_role。';

DO $$
DECLARE
  v_def TEXT;
BEGIN
  v_def := pg_get_functiondef('billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)'::regprocedure);
  IF position('v_bonus := LEAST(v_wallet.bonus_credits, v_amount);' in v_def) = 0 THEN
    RAISE EXCEPTION '20261111_light_text_bonus_first_debit: bonus-first split not installed';
  END IF;
END;
$$;

COMMIT;
NOTIFY pgrst, 'reload schema';
