-- 20261026_first_token_visible_billing.sql
-- domain: billing, experience
-- New requests require a positive client-visible token receipt before debit/quota consumption.
-- Existing requests retain their original policy; no retrospective charges/refunds.
-- A missing receipt keeps settlement pending up to deadline + 15 seconds, then waives fees.
-- The grace period accepts telemetry only; it does not extend the user's token deadline.
-- One transaction; short catalog/row locks; no table scan/backfill or new index.
-- Rollout: TEST migration + checks; deploy pending-aware backend first, then activate in production.
-- Recovery: transaction rollback before commit; after activation use forward-fix, never reopen waived charges.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE experience.chat_generation_requests
  ADD COLUMN IF NOT EXISTS requires_visible_token boolean NOT NULL DEFAULT false;
ALTER TABLE experience.chat_generation_requests
  ALTER COLUMN requires_visible_token SET DEFAULT true;
COMMENT ON COLUMN experience.chat_generation_requests.requires_visible_token IS
  'Display receipt protocol for new requests; legacy rows remain false. No receipt is not proof of display.';

CREATE OR REPLACE FUNCTION billing.chat_delivery_billing_gate(p_charge_key uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r experience.chat_generation_requests%ROWTYPE;
BEGIN
  SELECT r0.* INTO r FROM experience.chat_generation_requests r0
  JOIN experience.chat_history h ON h.id=r0.chat_history_id
  WHERE h.llm_charge_id=p_charge_key FOR UPDATE OF r0;
  IF NOT FOUND OR NOT r.requires_visible_token THEN RETURN 'legacy'; END IF;
  IF r.client_outcome='observed' AND r.client_first_token_visible_ms IS NOT NULL
     AND r.client_first_token_visible_ms < r.first_token_deadline_ms THEN RETURN 'visible'; END IF;
  IF r.first_token_timeout OR r.client_outcome IN ('timed_out','not_observed')
     OR clock_timestamp() >= r.request_received_at
       + make_interval(secs => r.first_token_deadline_ms::double precision / 1000 + 15)
    THEN RETURN 'waived'; END IF;
  RETURN 'pending';
END;
$$;
REVOKE ALL ON FUNCTION billing.chat_delivery_billing_gate(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.chat_delivery_billing_gate(uuid) TO service_role, postgres;

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
  v_delivery_gate TEXT;
BEGIN
  IF p_charge_key IS NULL OR p_user_id IS NULL
     OR COALESCE(btrim(p_model_openrouter_id), '') = ''
     OR COALESCE(btrim(p_model_display_name), '') = ''
     OR p_exchange_rate <= 0 OR p_model_markup < 0 THEN
    RAISE EXCEPTION 'invalid LLM usage charge input' USING ERRCODE = '22023';
  END IF;

  -- Serialize display receipt and debit eligibility on the same request row.
  -- No client receipt is never interpreted as a successful display.
  v_delivery_gate := billing.chat_delivery_billing_gate(p_charge_key);
  IF v_delivery_gate <> 'legacy' THEN
    v_metadata := v_metadata || jsonb_build_object('delivery_billing_gate', v_delivery_gate);
    IF COALESCE(v_metadata->>'chat_status', 'success') = 'success'
       AND (v_metadata->>'finish_reason' IS NULL OR v_metadata->>'finish_reason' = 'stop') THEN
      IF v_delivery_gate = 'pending' THEN
        v_metadata := v_metadata || jsonb_build_object(
          'billing_mode', 'fixed_tier', 'finish_reason', NULL);
      ELSIF v_delivery_gate = 'waived' THEN
        v_metadata := v_metadata || jsonb_build_object(
          'billing_mode', 'fixed_tier', 'chat_status', 'stream_interrupted', 'finish_reason', 'timeout');
      END IF;
    END IF;
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
    WHEN v_delivery_gate = 'pending' THEN 'awaiting_visible_token'
    WHEN v_delivery_gate = 'waived' THEN 'no_visible_token'
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

CREATE OR REPLACE FUNCTION billing.finalize_character_free_chat_round(
  p_charge_key UUID,
  p_success BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_decision billing.character_free_chat_quota_decisions;
  v_quota billing.character_free_chat_quotas;
  v_just_exhausted BOOLEAN := false;
  v_delivery_gate TEXT;
BEGIN
  -- Same lock order as charging: request, then quota/charge.
  v_delivery_gate := billing.chat_delivery_billing_gate(p_charge_key);
  IF p_success AND v_delivery_gate = 'waived' THEN p_success := false; END IF;
  SELECT * INTO v_decision
  FROM billing.character_free_chat_quota_decisions
  WHERE charge_key = p_charge_key;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'character free chat reservation not found: %', p_charge_key
      USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_quota
  FROM billing.character_free_chat_quotas
  WHERE user_id = v_decision.user_id
    AND character_id = v_decision.character_id
  FOR UPDATE;

  SELECT * INTO v_decision
  FROM billing.character_free_chat_quota_decisions
  WHERE charge_key = p_charge_key
  FOR UPDATE;

  IF v_decision.status = 'reserved' AND NOT (p_success AND v_delivery_gate = 'pending') THEN
    UPDATE billing.character_free_chat_quotas
    SET reserved_rounds = GREATEST(reserved_rounds - 1, 0),
        used_rounds = used_rounds + CASE WHEN p_success THEN 1 ELSE 0 END,
        updated_at = now()
    WHERE user_id = v_decision.user_id
      AND character_id = v_decision.character_id
    RETURNING * INTO v_quota;

    UPDATE billing.character_free_chat_quota_decisions
    SET status = CASE WHEN p_success THEN 'consumed' ELSE 'released' END,
        finalized_at = now()
    WHERE charge_key = p_charge_key
    RETURNING * INTO v_decision;

    v_just_exhausted := p_success AND v_quota.used_rounds = v_decision.quota_limit;
  END IF;

  RETURN jsonb_build_object(
    'granted_free', v_decision.granted_free,
    'status', v_decision.status,
    'used_rounds', v_quota.used_rounds,
    'remaining_rounds', GREATEST(v_decision.quota_limit - v_quota.used_rounds, 0),
    'just_exhausted', v_just_exhausted
  );
END;
$$;


-- CREATE OR REPLACE preserves the existing service-only grants.
REVOKE ALL ON FUNCTION billing.finalize_character_free_chat_round(uuid,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.finalize_character_free_chat_round(uuid,boolean) TO service_role, postgres;
REVOKE ALL ON FUNCTION billing.charge_llm_usage(uuid,text,uuid,text,text,text,integer,integer,numeric,numeric,numeric,numeric,boolean,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.charge_llm_usage(uuid,text,uuid,text,text,text,integer,integer,numeric,numeric,numeric,numeric,boolean,jsonb) TO service_role, postgres;
DO $$ BEGIN
  IF has_function_privilege('anon','billing.chat_delivery_billing_gate(uuid)','EXECUTE')
     OR has_function_privilege('authenticated','billing.chat_delivery_billing_gate(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'visible billing gate must be service-only';
  END IF;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
