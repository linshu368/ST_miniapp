-- 20260921_wallet_debit_refund.sql
-- domain: billing
--
-- T2 第 2/4 文件：内部统一扣款与原路退款。不得暴露给 anon/authenticated。
-- 业务能力到钱包策略的映射由服务端可信调用方决定，本函数不接受客户端 JWT。
-- 前置：20260921_vip_billing_schema.sql
-- 不改 charge_llm_usage / charge_voice_usage / settle_image_generation。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF to_regclass('billing.wallet_refunds') IS NULL
     OR to_regclass('billing.user_wallets') IS NULL
     OR to_regclass('billing.wallet_ledger') IS NULL THEN
    RAISE EXCEPTION '20260921_wallet_debit_refund: run 20260921_vip_billing_schema.sql first';
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
    v_main := LEAST(v_wallet.main_credits, v_amount);
    v_bonus := v_amount - v_main;
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

CREATE OR REPLACE FUNCTION billing.refund_wallet_debit(
  p_refund_key TEXT,
  p_debit_key TEXT,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_refund_key TEXT;
  v_debit_key TEXT;
  v_debit billing.wallet_ledger;
  v_existing billing.wallet_refunds;
  v_wallet billing.user_wallets;
  v_main NUMERIC(14,1);
  v_bonus NUMERIC(14,1);
  v_total NUMERIC(14,1);
  v_refund_ledger_id UUID;
BEGIN
  v_refund_key := btrim(COALESCE(p_refund_key, ''));
  v_debit_key := btrim(COALESCE(p_debit_key, ''));
  IF v_refund_key = '' OR v_debit_key = '' THEN
    RAISE EXCEPTION 'INVALID_AMOUNT'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
  INTO v_existing
  FROM billing.wallet_refunds
  WHERE refund_key = v_refund_key;

  IF FOUND THEN
    SELECT *
    INTO v_debit
    FROM billing.wallet_ledger
    WHERE id = v_existing.debit_ledger_id;
    IF NOT FOUND OR v_debit.debit_key IS DISTINCT FROM v_debit_key THEN
      RAISE EXCEPTION 'INVALID_AMOUNT'
        USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_wallet FROM billing.user_wallets WHERE user_id = v_existing.user_id;
    RETURN jsonb_build_object(
      'ok', true,
      'status', 'already_refunded',
      'refund_key', v_refund_key,
      'debit_key', v_debit_key,
      'refund_id', v_existing.refund_key,
      'ledger_id', v_existing.refund_ledger_id,
      'wallet', to_jsonb(v_wallet),
      'split', jsonb_build_object(
        'main_credits', v_existing.main_amount,
        'bonus_credits', v_existing.bonus_amount,
        'total_credits', v_existing.total_amount
      )
    );
  END IF;

  SELECT *
  INTO v_debit
  FROM billing.wallet_ledger
  WHERE debit_key = v_debit_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_AMOUNT'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT *
  INTO v_existing
  FROM billing.wallet_refunds
  WHERE debit_ledger_id = v_debit.id;

  IF FOUND THEN
    SELECT * INTO v_wallet FROM billing.user_wallets WHERE user_id = v_existing.user_id;
    RETURN jsonb_build_object(
      'ok', true,
      'status', 'already_refunded',
      'refund_key', v_refund_key,
      'debit_key', v_debit_key,
      'refund_id', v_existing.refund_key,
      'ledger_id', v_existing.refund_ledger_id,
      'wallet', to_jsonb(v_wallet),
      'split', jsonb_build_object(
        'main_credits', v_existing.main_amount,
        'bonus_credits', v_existing.bonus_amount,
        'total_credits', v_existing.total_amount
      )
    );
  END IF;

  IF v_debit.amount >= 0 OR v_debit.main_delta > 0 OR v_debit.bonus_delta > 0 THEN
    RAISE EXCEPTION 'INVALID_WALLET_SPLIT'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_debit.main_delta + v_debit.bonus_delta <> v_debit.amount THEN
    RAISE EXCEPTION 'INVALID_WALLET_SPLIT'
      USING ERRCODE = 'P0001';
  END IF;

  v_main := abs(v_debit.main_delta);
  v_bonus := abs(v_debit.bonus_delta);
  v_total := v_main + v_bonus;
  IF v_total <= 0 OR v_total <> abs(v_debit.amount) THEN
    RAISE EXCEPTION 'INVALID_AMOUNT'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO billing.user_wallets (user_id)
  VALUES (v_debit.user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT *
  INTO v_wallet
  FROM billing.user_wallets
  WHERE user_id = v_debit.user_id
  FOR UPDATE;

  BEGIN
    UPDATE billing.user_wallets
    SET
      main_credits = v_main + billing.user_wallets.main_credits,
      bonus_credits = v_bonus + billing.user_wallets.bonus_credits,
      updated_at = now()
    WHERE user_id = v_debit.user_id
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
      metadata
    ) VALUES (
      v_debit.user_id,
      'refund',
      v_total,
      v_main,
      v_bonus,
      v_wallet.main_credits,
      v_wallet.bonus_credits,
      'wallet_refund',
      v_refund_key,
      jsonb_build_object(
        'debit_key', v_debit_key,
        'refund_of', v_debit.id,
        'reason', p_reason
      )
    )
    RETURNING id INTO v_refund_ledger_id;

    INSERT INTO billing.wallet_refunds (
      refund_key,
      debit_ledger_id,
      refund_ledger_id,
      user_id,
      main_amount,
      bonus_amount,
      total_amount,
      reason
    ) VALUES (
      v_refund_key,
      v_debit.id,
      v_refund_ledger_id,
      v_debit.user_id,
      v_main,
      v_bonus,
      v_total,
      p_reason
    );
  EXCEPTION
    WHEN unique_violation THEN
      SELECT *
      INTO v_existing
      FROM billing.wallet_refunds
      WHERE debit_ledger_id = v_debit.id OR refund_key = v_refund_key
      LIMIT 1;
      IF NOT FOUND THEN
        RAISE;
      END IF;
      SELECT * INTO v_wallet FROM billing.user_wallets WHERE user_id = v_existing.user_id;
      RETURN jsonb_build_object(
        'ok', true,
        'status', 'already_refunded',
        'refund_key', v_existing.refund_key,
        'debit_key', v_debit_key,
        'refund_id', v_existing.refund_key,
        'ledger_id', v_existing.refund_ledger_id,
        'wallet', to_jsonb(v_wallet),
        'split', jsonb_build_object(
          'main_credits', v_existing.main_amount,
          'bonus_credits', v_existing.bonus_amount,
          'total_credits', v_existing.total_amount
        )
      );
  END;

  RETURN jsonb_build_object(
    'ok', true,
    'status', 'refunded',
    'refund_key', v_refund_key,
    'debit_key', v_debit_key,
    'ledger_id', v_refund_ledger_id,
    'wallet', to_jsonb(v_wallet),
    'split', jsonb_build_object(
      'main_credits', v_main,
      'bonus_credits', v_bonus,
      'total_credits', v_total
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION billing.apply_wallet_debit(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.apply_wallet_debit(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, JSONB)
  TO postgres, service_role;

REVOKE ALL ON FUNCTION billing.refund_wallet_debit(TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.refund_wallet_debit(TEXT, TEXT, TEXT)
  TO postgres, service_role;

COMMENT ON FUNCTION billing.apply_wallet_debit(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, JSONB) IS
  '内部统一扣款。main_only / main_then_bonus；余额不足整笔失败；debit_key 幂等。仅 service_role。';
COMMENT ON FUNCTION billing.refund_wallet_debit(TEXT, TEXT, TEXT) IS
  '按原始 debit 拆分原路退款。refund_key 与 debit 均只成功一次。仅 service_role。';

DO $$
DECLARE
  v_cfg TEXT[];
BEGIN
  IF to_regprocedure('billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)') IS NULL
     OR to_regprocedure('billing.refund_wallet_debit(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'postflight: debit/refund functions missing';
  END IF;

  SELECT proconfig INTO v_cfg
  FROM pg_proc
  WHERE oid = 'billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)'::regprocedure;
  IF v_cfg IS NULL OR NOT ('search_path=pg_catalog' = ANY (v_cfg)) THEN
    RAISE EXCEPTION 'postflight: apply_wallet_debit search_path is not pg_catalog';
  END IF;

  SELECT proconfig INTO v_cfg
  FROM pg_proc
  WHERE oid = 'billing.refund_wallet_debit(text,text,text)'::regprocedure;
  IF v_cfg IS NULL OR NOT ('search_path=pg_catalog' = ANY (v_cfg)) THEN
    RAISE EXCEPTION 'postflight: refund_wallet_debit search_path is not pg_catalog';
  END IF;

  IF has_function_privilege('anon', 'billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'billing.refund_wallet_debit(text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'billing.refund_wallet_debit(text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postflight: debit/refund must not be executable by anon/authenticated';
  END IF;

  IF NOT has_function_privilege('service_role', 'billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'billing.refund_wallet_debit(text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postflight: service_role must be able to execute debit/refund';
  END IF;
END;
$$;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- 回滚：DROP FUNCTION 两个 RPC。已产生 ledger/refund 行后不得删表，用 forward-fix。
