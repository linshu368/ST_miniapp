-- 20260922_llm_vip_wallet_charge.sql
-- domain: billing
--
-- T4：文本扣费改为受理快照 + apply_wallet_debit。不新建表，不改 T2/T3 已 apply 文件。
-- 轻量 main_then_bonus，标准/旗舰 main_only。余额不足整笔回滚，不再写入 partial。
-- 历史 partial 行只读返回。finish_reason 闸门与 pending 重放保持原语义。
--
-- 实付金额只读 charge metadata / 调用方传入的快照，不在 SQL 里乘 0.95，也不读目录价。
-- 已存在行的 payable_credits、其次 fixed_deduction，优先于后到的 calculated_amount。
--
-- 前置：billing.apply_wallet_debit、billing.refund_wallet_debit、billing.llm_usage_charges。
-- 锁：CREATE OR REPLACE FUNCTION。lock_timeout 5s，statement_timeout 60s。不建索引，不回填。
-- 权限：DEFINER，search_path=pg_catalog，anon/authenticated 不可执行。
-- 执行：GitHub Actions Database Migration，environment=test，一次一个文件。
--       未获明确批准不得 apply。禁止对 Production 执行。
-- 恢复：新扣款发生前可用 forward-fix 换回旧函数体。已扣款后走 refund_llm_usage_charge，不 down migration。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF to_regclass('billing.llm_usage_charges') IS NULL
     OR to_regclass('billing.user_wallets') IS NULL
     OR to_regclass('billing.wallet_ledger') IS NULL THEN
    RAISE EXCEPTION '20260922_llm_vip_wallet_charge: billing charge tables missing';
  END IF;
  IF to_regprocedure('billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)') IS NULL
     OR to_regprocedure('billing.refund_wallet_debit(text,text,text)') IS NULL THEN
    RAISE EXCEPTION '20260922_llm_vip_wallet_charge: wallet debit primitives missing';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION billing.charge_llm_usage(
  p_charge_key UUID,
  p_generation_id TEXT,
  p_user_id UUID,
  p_model_id TEXT,
  p_model_openrouter_id TEXT,
  p_model_display_name TEXT,
  p_catalog_version INTEGER,
  p_pricing_config_version INTEGER,
  p_usage_cost_usd NUMERIC,
  p_exchange_rate NUMERIC,
  p_model_markup NUMERIC,
  p_calculated_amount NUMERIC,
  p_fallback_used BOOLEAN,
  p_metadata JSONB DEFAULT '{}'::JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_existing billing.llm_usage_charges;
  v_charge billing.llm_usage_charges;
  v_metadata JSONB := COALESCE(p_metadata, '{}'::JSONB);
  v_stored JSONB;
  v_quote_metadata JSONB;
  v_fixed BOOLEAN;
  v_chat_status TEXT;
  v_finish_reason TEXT;
  v_waiting_finish BOOLEAN;
  v_non_billable_fixed BOOLEAN;
  v_pending BOOLEAN;
  v_quoted NUMERIC;
  v_amount NUMERIC(14,1);
  v_policy TEXT;
  v_category TEXT;
  v_debit_key TEXT;
  v_debit JSONB;
  v_ledger_id UUID;
  v_main NUMERIC(14,1) := 0;
  v_bonus NUMERIC(14,1) := 0;
  v_wallet_json JSONB;
  v_billing_gate TEXT;
  v_difference_reason TEXT;
  v_has_existing BOOLEAN := false;
BEGIN
  IF p_charge_key IS NULL OR p_user_id IS NULL
     OR COALESCE(btrim(p_model_openrouter_id), '') = ''
     OR COALESCE(btrim(p_model_display_name), '') = ''
     OR p_exchange_rate <= 0 OR p_model_markup < 0 THEN
    RAISE EXCEPTION 'invalid LLM usage charge input' USING ERRCODE = '22023';
  END IF;

  v_fixed := COALESCE(v_metadata ->> 'billing_mode', '') = 'fixed_tier';
  v_chat_status := COALESCE(v_metadata ->> 'chat_status', 'success');
  v_finish_reason := v_metadata ->> 'finish_reason';
  v_waiting_finish := v_fixed AND v_chat_status = 'success' AND v_finish_reason IS NULL;
  v_non_billable_fixed := v_fixed
    AND NOT v_waiting_finish
    AND (v_chat_status <> 'success' OR v_finish_reason <> 'stop');
  v_pending := CASE
    WHEN v_fixed THEN v_waiting_finish
    ELSE p_model_markup > 0
      AND (COALESCE(p_fallback_used, false) OR p_usage_cost_usd IS NULL)
  END;
  v_debit_key := p_charge_key::TEXT;

  SELECT * INTO v_existing
  FROM billing.llm_usage_charges
  WHERE charge_key = p_charge_key
     OR (p_generation_id IS NOT NULL AND generation_id = p_generation_id)
  ORDER BY (charge_key = p_charge_key) DESC
  LIMIT 1
  FOR UPDATE;
  v_has_existing := FOUND;

  IF v_has_existing AND v_existing.status <> 'pending' THEN
    SELECT to_jsonb(w.*) INTO v_wallet_json
    FROM billing.user_wallets w
    WHERE w.user_id = v_existing.user_id
    FOR UPDATE;
    RETURN jsonb_build_object(
      'charge_status', 'already_charged',
      'wallet', v_wallet_json,
      'charge', to_jsonb(v_existing)
    );
  END IF;

  v_quote_metadata := CASE
    WHEN NOT v_has_existing THEN '{}'::JSONB
    ELSE COALESCE(v_existing.metadata, '{}'::JSONB)
  END;
  -- 已落库的快照优先于本次参数，避免目录改价或 VIP 到期后重放改写本轮实付。
  v_quoted := COALESCE(
    NULLIF(v_quote_metadata ->> 'payable_credits', '')::NUMERIC,
    NULLIF(v_quote_metadata ->> 'fixed_deduction', '')::NUMERIC,
    NULLIF(v_metadata ->> 'payable_credits', '')::NUMERIC,
    NULLIF(v_metadata ->> 'fixed_deduction', '')::NUMERIC,
    p_calculated_amount,
    0
  );
  IF v_quoted < 0 OR (v_quoted > 0 AND v_quoted <> trunc(v_quoted)) THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001';
  END IF;

  v_amount := CASE
    WHEN v_fixed AND (v_waiting_finish OR v_non_billable_fixed) THEN 0
    WHEN v_fixed THEN v_quoted
    WHEN p_model_markup = 0 OR v_pending THEN 0
    ELSE v_quoted
  END;

  v_category := COALESCE(
    NULLIF(v_quote_metadata ->> 'fixed_deduction_category', ''),
    NULLIF(v_metadata ->> 'fixed_deduction_category', ''),
    NULLIF(v_quote_metadata ->> 'model_tier', ''),
    NULLIF(v_metadata ->> 'model_tier', '')
  );
  v_policy := NULLIF(btrim(COALESCE(
    NULLIF(v_quote_metadata ->> 'wallet_policy', ''),
    NULLIF(v_metadata ->> 'wallet_policy', '')
  )), '');
  IF v_policy IS NULL AND v_amount > 0 THEN
    IF v_category IN ('light', 'free_quota', 'free_quota_exhausted', 'text_light') THEN
      v_policy := 'main_then_bonus';
    ELSIF v_category IN ('standard', 'premium', 'standard_fallback', 'text_standard', 'text_premium') THEN
      v_policy := 'main_only';
    END IF;
  END IF;
  IF v_amount > 0 AND v_policy IS NULL THEN
    RAISE EXCEPTION 'UNSUPPORTED_WALLET_POLICY' USING ERRCODE = 'P0001';
  END IF;
  IF v_policy IS NOT NULL AND v_policy NOT IN ('main_only', 'main_then_bonus') THEN
    RAISE EXCEPTION 'UNSUPPORTED_WALLET_POLICY' USING ERRCODE = 'P0001';
  END IF;

  v_billing_gate := CASE
    WHEN v_fixed AND v_waiting_finish THEN 'pending_finish_reason'
    WHEN v_fixed AND v_non_billable_fixed THEN 'non_billable'
    WHEN v_fixed AND v_amount = 0 THEN 'free'
    WHEN v_fixed THEN 'billable'
    WHEN p_model_markup = 0 THEN 'free'
    WHEN v_pending THEN 'deferred'
    ELSE 'actual_usage'
  END;
  v_difference_reason := CASE
    WHEN v_fixed AND v_waiting_finish THEN 'awaiting_finish_reason'
    WHEN v_fixed AND v_chat_status = 'stream_interrupted' THEN 'stream_interrupted'
    WHEN v_fixed AND v_chat_status = 'upstream_error' THEN 'upstream_error'
    WHEN v_fixed AND v_finish_reason = 'content_filter' THEN 'content_filter'
    WHEN v_fixed AND v_finish_reason = 'length' THEN 'length'
    WHEN v_fixed AND v_finish_reason IN ('tool_calls', 'function_call') THEN 'tool_call'
    WHEN v_fixed AND v_non_billable_fixed THEN 'non_stop_finish_reason'
    WHEN NOT v_fixed AND p_model_markup = 0 THEN 'free_model'
    WHEN NOT v_fixed AND v_pending THEN 'awaiting_openrouter_usage'
    ELSE NULL
  END;

  IF v_has_existing AND v_existing.status = 'pending' AND v_waiting_finish THEN
    SELECT to_jsonb(w.*) INTO v_wallet_json
    FROM billing.user_wallets w
    WHERE w.user_id = v_existing.user_id
    FOR UPDATE;
    RETURN jsonb_build_object(
      'charge_status', 'already_pending',
      'wallet', v_wallet_json,
      'charge', to_jsonb(v_existing)
    );
  END IF;

  v_stored := CASE
    WHEN NOT v_has_existing THEN v_metadata
    ELSE COALESCE(v_existing.metadata, '{}'::JSONB) || (
      v_metadata
        - 'payable_credits' - 'fixed_deduction' - 'wallet_policy'
        - 'original_credits' - 'discount_rate' - 'discounted_exact'
        - 'vip_active' - 'vip_valid_until' - 'model_tier'
        - 'requires_vip' - 'fixed_deduction_category'
    )
  END;
  v_stored := v_stored || jsonb_strip_nulls(jsonb_build_object(
    'payable_credits', v_quoted,
    'wallet_policy', v_policy,
    'billing_mode', CASE
      WHEN v_fixed THEN 'fixed_tier'
      WHEN p_model_markup = 0 THEN 'free'
      WHEN v_pending THEN 'deferred'
      ELSE 'actual_usage'
    END,
    'billing_gate', v_billing_gate,
    'finish_reason', v_finish_reason,
    'difference_reason', v_difference_reason
  ));

  IF v_has_existing THEN
    IF v_amount > 0 THEN
      -- 不足时异常冒泡，整笔回滚。pending 保持原状，由 sync 以后重试，不写 partial。
      v_debit_key := v_existing.charge_key::TEXT;
      v_debit := billing.apply_wallet_debit(
        v_existing.user_id,
        v_debit_key,
        v_policy,
        v_amount,
        'chat_debit',
        'llm_usage',
        v_debit_key,
        v_stored || jsonb_build_object(
          'generation_id', COALESCE(p_generation_id, v_existing.generation_id),
          'model', p_model_openrouter_id,
          'calculated_amount', v_amount
        )
      );
      v_ledger_id := (v_debit ->> 'ledger_id')::UUID;
      v_main := (v_debit -> 'split' ->> 'main_credits')::NUMERIC;
      v_bonus := (v_debit -> 'split' ->> 'bonus_credits')::NUMERIC;
      v_wallet_json := v_debit -> 'wallet';
      v_stored := v_stored || jsonb_build_object(
        'main_delta', -v_main,
        'bonus_delta', -v_bonus,
        'debit_key', v_debit_key
      );
    ELSE
      INSERT INTO billing.user_wallets (user_id)
      VALUES (v_existing.user_id)
      ON CONFLICT (user_id) DO NOTHING;
      SELECT to_jsonb(w.*) INTO v_wallet_json
      FROM billing.user_wallets w
      WHERE w.user_id = v_existing.user_id;
    END IF;

    UPDATE billing.llm_usage_charges
    SET generation_id = COALESCE(p_generation_id, generation_id),
        model_openrouter_id = p_model_openrouter_id,
        model_display_name = p_model_display_name,
        usage_cost_usd = p_usage_cost_usd,
        calculated_amount = v_amount,
        charged_amount = v_amount,
        fallback_used = false,
        status = CASE
          WHEN v_non_billable_fixed THEN 'failed'
          WHEN v_amount = 0 THEN 'free'
          ELSE 'charged'
        END,
        debit_ledger_id = COALESCE(v_ledger_id, debit_ledger_id),
        metadata = v_stored,
        reconciled_at = now()
    WHERE charge_key = v_existing.charge_key
    RETURNING * INTO v_charge;
  ELSE
    BEGIN
      IF v_amount > 0 THEN
        v_debit := billing.apply_wallet_debit(
          p_user_id,
          v_debit_key,
          v_policy,
          v_amount,
          'chat_debit',
          'llm_usage',
          v_debit_key,
          v_stored || jsonb_build_object(
            'generation_id', p_generation_id,
            'model', p_model_openrouter_id,
            'calculated_amount', v_amount
          )
        );
        v_ledger_id := (v_debit ->> 'ledger_id')::UUID;
        v_main := (v_debit -> 'split' ->> 'main_credits')::NUMERIC;
        v_bonus := (v_debit -> 'split' ->> 'bonus_credits')::NUMERIC;
        v_wallet_json := v_debit -> 'wallet';
        v_stored := v_stored || jsonb_build_object(
          'main_delta', -v_main,
          'bonus_delta', -v_bonus,
          'debit_key', v_debit_key
        );
      ELSE
        INSERT INTO billing.user_wallets (user_id)
        VALUES (p_user_id)
        ON CONFLICT (user_id) DO NOTHING;
        SELECT to_jsonb(w.*) INTO v_wallet_json
        FROM billing.user_wallets w
        WHERE w.user_id = p_user_id;
      END IF;

      INSERT INTO billing.llm_usage_charges(
        charge_key, generation_id, user_id, model_id, model_openrouter_id,
        model_display_name, catalog_version, pricing_config_version,
        usage_cost_usd, exchange_rate, model_markup, initial_amount,
        calculated_amount, charged_amount, fallback_used, status,
        debit_ledger_id, metadata
      ) VALUES (
        p_charge_key, p_generation_id, p_user_id, p_model_id, p_model_openrouter_id,
        p_model_display_name, COALESCE(p_catalog_version, 0),
        COALESCE(p_pricing_config_version, 0), p_usage_cost_usd, p_exchange_rate,
        p_model_markup, v_amount, v_amount, v_amount, false,
        CASE
          WHEN v_pending THEN 'pending'
          WHEN v_fixed AND v_non_billable_fixed THEN 'failed'
          WHEN v_amount = 0 THEN 'free'
          ELSE 'charged'
        END,
        v_ledger_id, v_stored
      ) RETURNING * INTO v_charge;
    EXCEPTION
      WHEN unique_violation THEN
        -- 子事务回滚本次 debit。赢家的行已经提交，按它返回。
        SELECT * INTO v_existing
        FROM billing.llm_usage_charges
        WHERE charge_key = p_charge_key
           OR (p_generation_id IS NOT NULL AND generation_id = p_generation_id)
        ORDER BY (charge_key = p_charge_key) DESC
        LIMIT 1;
        SELECT to_jsonb(w.*) INTO v_wallet_json
        FROM billing.user_wallets w
        WHERE w.user_id = v_existing.user_id;
        RETURN jsonb_build_object(
          'charge_status', 'already_charged',
          'wallet', v_wallet_json,
          'charge', to_jsonb(v_existing)
        );
    END;
  END IF;

  RETURN jsonb_build_object(
    'charge_status', v_charge.status,
    'wallet', v_wallet_json,
    'charge', to_jsonb(v_charge)
  );
END;
$$;

CREATE OR REPLACE FUNCTION billing.refund_llm_usage_charge(
  p_charge_key UUID,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_charge billing.llm_usage_charges;
  v_debit_key TEXT;
  v_ledger_key TEXT;
  v_refund JSONB;
  v_wallet_json JSONB;
  v_status TEXT;
BEGIN
  IF p_charge_key IS NULL THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_charge
  FROM billing.llm_usage_charges
  WHERE charge_key = p_charge_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'status', 'not_found');
  END IF;

  SELECT to_jsonb(w.*) INTO v_wallet_json
  FROM billing.user_wallets w
  WHERE w.user_id = v_charge.user_id;

  IF v_charge.charged_amount <= 0 OR v_charge.debit_ledger_id IS NULL
     OR v_charge.status IN ('pending', 'free', 'failed') THEN
    RETURN jsonb_build_object(
      'ok', true,
      'status', 'not_debited',
      'wallet', v_wallet_json,
      'charge', to_jsonb(v_charge)
    );
  END IF;

  v_debit_key := p_charge_key::TEXT;
  SELECT ledger.debit_key INTO v_ledger_key
  FROM billing.wallet_ledger ledger
  WHERE ledger.id = v_charge.debit_ledger_id;

  -- 旧扣款没有 debit_key，不能猜拆分。保持余额不动。
  IF v_ledger_key IS NULL OR v_ledger_key IS DISTINCT FROM v_debit_key THEN
    RETURN jsonb_build_object(
      'ok', true,
      'status', 'not_refundable',
      'wallet', v_wallet_json,
      'charge', to_jsonb(v_charge)
    );
  END IF;

  v_refund := billing.refund_wallet_debit(
    'llm-refund:' || v_debit_key,
    v_debit_key,
    'llm_usage'
  );
  v_status := v_refund ->> 'status';
  v_wallet_json := v_refund -> 'wallet';

  UPDATE billing.llm_usage_charges
  SET metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_strip_nulls(jsonb_build_object(
        'compensation_status', 'refunded',
        'business_status', 'refunded',
        'refund_key', v_refund ->> 'refund_key',
        'refund_of', v_debit_key,
        'compensation_reason', NULLIF(btrim(COALESCE(p_reason, '')), '')
      )),
      reconciled_at = now()
  WHERE charge_key = p_charge_key
  RETURNING * INTO v_charge;

  RETURN jsonb_build_object(
    'ok', true,
    'status', v_status,
    'wallet', v_wallet_json,
    'charge', to_jsonb(v_charge),
    'split', v_refund -> 'split'
  );
END;
$$;

REVOKE ALL ON FUNCTION billing.charge_llm_usage(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.charge_llm_usage(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, JSONB
) TO service_role, postgres;

REVOKE ALL ON FUNCTION billing.refund_llm_usage_charge(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.refund_llm_usage_charge(UUID, TEXT)
  TO service_role, postgres;

COMMENT ON FUNCTION billing.charge_llm_usage(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, JSONB
) IS
  'Idempotent LLM charge. Fixed-tier debits only on finish_reason=stop, using the accepted price snapshot and apply_wallet_debit. Insufficient balance rolls back; new rows are never partial.';

COMMENT ON FUNCTION billing.refund_llm_usage_charge(UUID, TEXT) IS
  'Refunds one LLM debit through refund_wallet_debit. Historical ledgers without debit_key are not refundable.';

DO $$
DECLARE
  v_config TEXT;
BEGIN
  IF to_regprocedure('billing.charge_llm_usage(uuid,text,uuid,text,text,text,integer,integer,numeric,numeric,numeric,numeric,boolean,jsonb)') IS NULL
     OR to_regprocedure('billing.refund_llm_usage_charge(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'postflight: llm charge functions missing';
  END IF;

  SELECT regexp_replace(pg_get_functiondef(
    'billing.charge_llm_usage(uuid,text,uuid,text,text,text,integer,integer,numeric,numeric,numeric,numeric,boolean,jsonb)'::regprocedure
  ), '\s+', ' ', 'g') INTO v_config;
  IF v_config NOT LIKE '%SET search_path TO ''pg_catalog''%'
     AND v_config NOT LIKE '%SET search_path TO pg_catalog%' THEN
    RAISE EXCEPTION 'postflight: charge_llm_usage search_path is not pg_catalog';
  END IF;
  IF position('apply_wallet_debit' IN v_config) = 0 THEN
    RAISE EXCEPTION 'postflight: charge_llm_usage does not call apply_wallet_debit';
  END IF;

  SELECT regexp_replace(pg_get_functiondef(
    'billing.refund_llm_usage_charge(uuid,text)'::regprocedure
  ), '\s+', ' ', 'g') INTO v_config;
  IF position('refund_wallet_debit' IN v_config) = 0 THEN
    RAISE EXCEPTION 'postflight: refund_llm_usage_charge does not call refund_wallet_debit';
  END IF;

  IF has_function_privilege('anon', 'billing.charge_llm_usage(uuid,text,uuid,text,text,text,integer,integer,numeric,numeric,numeric,numeric,boolean,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'billing.charge_llm_usage(uuid,text,uuid,text,text,text,integer,integer,numeric,numeric,numeric,numeric,boolean,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'billing.refund_llm_usage_charge(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'billing.refund_llm_usage_charge(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postflight: llm charge functions are executable by anon or authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', 'billing.charge_llm_usage(uuid,text,uuid,text,text,text,integer,integer,numeric,numeric,numeric,numeric,boolean,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'billing.refund_llm_usage_charge(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postflight: service_role cannot execute llm charge functions';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
