-- Domain: billing（文本扣费）——数据库重组阶段 6b-1c 写方切换（二）：扣费链路直写 billing.usage_charges。
-- 规格见 .trellis/tasks/11-19-db-reorg-p6-billing/design.md「写方切换 PR②」。
--
-- charge_llm_usage / reconcile_llm_usage / refund_llm_usage_charge 改为读写 usage_charges，不再写旧扣费表
-- billing.llm_usage_charges（它的镜像、prepare、retain 触发器随之失效，收缩时删）。
-- 新表的行与旧表、去重表的对应：
--   - 有 quote.charge：等同旧表有这一行（pending 或终态）；
--   - 没有明细、状态是终态：等同"旧行已被保留触发器删、只剩去重记录"——扣费返回 already_archived，退款 not_found，与现在相同；
--   - 没有明细、状态 quoted：还没扣费，照常扣费并写回这一行；
--   - 找不到：照常扣费，新建一行。
-- 写入的每个字段都与旧路径"写旧表 → 镜像同步"的结果相同；旧表 BEFORE INSERT 触发器的免费模型失败规则搬进扣费函数。
-- 返回给后端的 charge 由 billing.chat_charge_json 拼出旧表一行的形状（11-21 生产只读：最近 1 天 3948 笔逐条相同），后端不用改。
-- 新增：
--   - billing.chat_charge_json(usage_charges)、billing.chat_archived_charge_result(usage_charges, uuid)；
--   - billing.grant_character_creator_reward(usage_charges) 重载（旧重载收缩时随旧表删）；
--   - usage_charges(generation_id) 唯一部分索引，替代旧表同名约束防止同一次上游调用重复扣费（生产无重复）。
-- 已知差异：11-20 之后才被旧表删掉的扣费，重放时返回带明细的 already_charged（以前 already_archived），扣费额相同。
-- 本文件：
--   1. 守卫三个函数要么是生产原版、要么已是新版本，否则拒绝；
--   2. 建辅助函数、在线建唯一索引；
--   3. 一个事务里：先用真实数据核对返回形状（最近 1 天旧表每行与 chat_charge_json 相同），再按原文 md5 切换三个函数并核对新 md5。
--
-- Verify: bash scripts/test-db-reorg-p6b1c-charge-chain.sh
-- Release: TEST -> Production（不需要后端发布）。前后跑 R1 文本按日对账。
-- Rollback: 用 packages/shared/migrations/fixtures/p6b1c_charge_chain_originals.sql 里的原版定义（只取三个函数）重建。

DO $guard$
DECLARE
  v_md5 text;
BEGIN
  FOR v_md5 IN
    SELECT p.oid::regprocedure::text || '=' || md5(p.prosrc) FROM pg_proc p
    WHERE p.oid IN ('billing.charge_llm_usage(uuid,text,uuid,text,text,text,integer,integer,numeric,numeric,numeric,numeric,boolean,jsonb)'::regprocedure, 'billing.reconcile_llm_usage(uuid,numeric,numeric,jsonb)'::regprocedure, 'billing.refund_llm_usage_charge(uuid,text)'::regprocedure)
      AND md5(p.prosrc) NOT IN ('dd164728b74f6e07a94c137b9d92d4d8', 'e27bb6f2e5a63910c5c9539f5e1fcf8b', '49318c359afc4167c4debd0a9f9173d4', '6633b10c4381245abb9baa381c8eca08', '42a06a0793b7ff5858624b97a1cfef1f', 'b1b153d59a17b7dab85fd725573eb563')
  LOOP
    RAISE EXCEPTION 'p6b1c-charge: drifted function %, refusing', v_md5;
  END LOOP;
END
$guard$;

CREATE OR REPLACE FUNCTION billing.chat_charge_json(p_charge billing.usage_charges)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $fn$
  -- 文本扣费返回给后端的形状，与 6b-1c 之前旧扣费表的一行相同（不含旧表自增 id；上游成本归 ops.llm_calls，恒为 null）。
  SELECT jsonb_build_object(
    'charge_key', p_charge.id, 'generation_id', p_charge.generation_id, 'user_id', p_charge.user_id,
    'model_id', c -> 'model_id', 'model_openrouter_id', c -> 'model_openrouter_id', 'model_display_name', c -> 'model_display_name',
    'catalog_version', c -> 'catalog_version', 'pricing_config_version', c -> 'pricing_config_version', 'usage_cost_usd', NULL,
    'exchange_rate', c -> 'exchange_rate', 'model_markup', c -> 'model_markup', 'initial_amount', c -> 'initial_amount',
    'calculated_amount', c -> 'calculated_amount', 'charged_amount', p_charge.charged_credits, 'fallback_used', c -> 'fallback_used',
    'status', p_charge.status, 'debit_ledger_id', p_charge.debit_ledger_id, 'metadata', c -> 'metadata',
    'created_at', c -> 'charged_at', 'updated_at', p_charge.updated_at, 'reconciled_at', c -> 'reconciled_at')
  FROM (SELECT p_charge.quote -> 'charge' AS c) d
$fn$;

CREATE OR REPLACE FUNCTION billing.chat_archived_charge_result(p_charge billing.usage_charges, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  -- A settled charge whose detail was pruned before db reorg 6b-1 (formerly llm_usage_charge_dedup):
  -- only the durable result survives, never a fabricated detail row.
  IF p_charge.user_id IS DISTINCT FROM p_user_id
     OR p_charge.status NOT IN ('failed','free','charged','partial','reconciled','historical')
     OR p_charge.charged_credits IS NULL OR p_charge.charged_credits < 0 THEN
    RAISE EXCEPTION 'Invalid archived LLM charge result' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object(
    'charge_status','already_archived',
    'archived_charge',jsonb_build_object(
      'charge_key',p_charge.id,'generation_id',p_charge.generation_id,
      'user_id',p_charge.user_id,'status',p_charge.status,
      'charged_amount',p_charge.charged_credits));
END
$fn$;

CREATE OR REPLACE FUNCTION billing.grant_character_creator_reward(p_charge billing.usage_charges)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $fn$
DECLARE v_rule jsonb; v_creator uuid; v_reward numeric(14,1); v_offset numeric(14,1);
  v_credit numeric(14,1); v_debt numeric(14,1); v_ledger uuid; v_metadata jsonb;
BEGIN
  -- db reorg 6b-1c: the charge detail lives in usage_charges.quote.charge; same rules as the llm_usage_charges overload.
  v_metadata := p_charge.quote->'charge'->'metadata';
  v_rule := v_metadata->'creator_reward';
  IF v_rule IS NULL OR p_charge.charged_credits <= 0
    OR p_charge.status IN ('pending','free','failed')
    OR v_metadata->>'business_status' = 'refunded' THEN RETURN; END IF;
  v_creator := (v_rule->>'creator_user_id')::uuid;
  IF v_creator = p_charge.user_id THEN RETURN; END IF;
  -- Called only by the final charge branch; an archived or duplicate charge
  -- returns earlier and cannot recreate grants after detail retention.
  IF EXISTS(SELECT 1 FROM billing.character_creator_rewards WHERE charge_key=p_charge.id) THEN RETURN; END IF;
  v_reward := round(p_charge.charged_credits * (v_rule->>'rate')::numeric, 1);
  IF v_reward <= 0 THEN RETURN; END IF;
  INSERT INTO billing.character_creator_reward_balances(creator_user_id)
    VALUES(v_creator) ON CONFLICT(creator_user_id) DO NOTHING;
  SELECT outstanding_debt INTO v_debt FROM billing.character_creator_reward_balances
    WHERE creator_user_id=v_creator FOR UPDATE;
  v_offset := least(v_debt, v_reward);
  v_credit := v_reward-v_offset;
  UPDATE billing.character_creator_reward_balances
    SET outstanding_debt=outstanding_debt-v_offset, updated_at=now()
    WHERE creator_user_id=v_creator;
  IF v_credit > 0 THEN
    SELECT o_ledger_id INTO v_ledger FROM billing.grant_bonus_credits(
      v_creator, v_credit, 'creator_reward', 'llm_creator_reward', p_charge.id::text,
      jsonb_build_object('charge_key',p_charge.id,'character_id',v_rule->>'character_id',
        'charged_amount',p_charge.charged_credits,'reward_amount',v_reward,
        'debt_offset_amount',v_offset,'policy_version',1));
  END IF;
  INSERT INTO billing.character_creator_rewards(charge_key, character_id, creator_user_id,
    payer_user_id, charged_amount, reward_rate, reward_amount, debt_offset_amount,
    credited_amount, grant_ledger_id)
  VALUES(p_charge.id,(v_rule->>'character_id')::uuid,v_creator,p_charge.user_id,
    p_charge.charged_credits,0.4,v_reward,v_offset,v_credit,v_ledger);
END
$fn$;


REVOKE ALL ON FUNCTION billing.chat_charge_json(billing.usage_charges) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION billing.chat_archived_charge_result(billing.usage_charges, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION billing.grant_character_creator_reward(billing.usage_charges) FROM PUBLIC, anon, authenticated;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS usage_charges_generation_key
  ON billing.usage_charges (generation_id) WHERE generation_id IS NOT NULL;
DROP INDEX CONCURRENTLY IF EXISTS billing.usage_charges_generation_idx;

DO $switch$
DECLARE
  v_md5 text;
  v_done int := 0;
  v_rows bigint;
  v_diff bigint;
BEGIN
  SET LOCAL lock_timeout = '1s';
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = 'billing.usage_charges_generation_key'::regclass AND indisvalid AND indisunique) THEN
    RAISE EXCEPTION 'p6b1c-charge: usage_charges_generation_key is missing or invalid; drop it and rerun';
  END IF;
  -- 返回形状：最近 1 天旧表每一行与 chat_charge_json 相同（时间按时刻比较，避免时区格式差异）
  SELECT count(*), count(*) FILTER (WHERE
      (to_jsonb(c) - 'id' - 'usage_cost_usd' - 'created_at' - 'updated_at' - 'reconciled_at')
        IS DISTINCT FROM (billing.chat_charge_json(u) - 'usage_cost_usd' - 'created_at' - 'updated_at' - 'reconciled_at')
      OR c.created_at IS DISTINCT FROM (u.quote -> 'charge' ->> 'charged_at')::timestamptz
      OR c.reconciled_at IS DISTINCT FROM (u.quote -> 'charge' ->> 'reconciled_at')::timestamptz)
  INTO v_rows, v_diff
  FROM billing.llm_usage_charges c JOIN billing.usage_charges u ON u.id = c.charge_key
  WHERE c.created_at > now() - interval '1 day';
  IF v_diff > 0 THEN
    RAISE EXCEPTION 'p6b1c-charge: % / % recent charges differ from chat_charge_json; refusing', v_diff, v_rows;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'billing.charge_llm_usage(uuid,text,uuid,text,text,text,integer,integer,numeric,numeric,numeric,numeric,boolean,jsonb)'::regprocedure;
  IF v_md5 = 'dd164728b74f6e07a94c137b9d92d4d8' THEN
    EXECUTE $def_charge$CREATE OR REPLACE FUNCTION billing.charge_llm_usage(p_charge_key uuid, p_generation_id text, p_user_id uuid, p_model_id text, p_model_openrouter_id text, p_model_display_name text, p_catalog_version integer, p_pricing_config_version integer, p_usage_cost_usd numeric, p_exchange_rate numeric, p_model_markup numeric, p_calculated_amount numeric, p_fallback_used boolean, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  -- db reorg 6b-1c: billing.usage_charges is the only charge record. A row is
  --   * charged detail  (quote ? 'charge')            -> what llm_usage_charges used to hold;
  --   * archived result (no detail, terminal status)  -> what llm_usage_charge_dedup used to hold after pruning;
  --   * open quote      (no detail, status 'quoted')  -> no charge yet: this call charges and fills that row.
  v_existing billing.usage_charges;
  v_charge billing.usage_charges;
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
  v_open_quote BOOLEAN := false;
  v_delivery_gate TEXT;
  v_stop_snapshot JSONB;
  v_status TEXT;
  v_recorded NUMERIC(14,1);
BEGIN
  IF p_charge_key IS NULL OR p_user_id IS NULL
     OR COALESCE(btrim(p_model_openrouter_id), '') = ''
     OR COALESCE(btrim(p_model_display_name), '') = ''
     OR p_exchange_rate <= 0 OR p_model_markup < 0 THEN
    RAISE EXCEPTION 'invalid LLM usage charge input' USING ERRCODE = '22023';
  END IF;

  -- Read-only terminal fast path: no request-row lock for settled keys.
  -- Charged rows outrank archived results, which outrank open quotes; the own key wins ties.
  SELECT * INTO v_existing
  FROM billing.usage_charges
  WHERE kind = 'chat_text'
    AND (id = p_charge_key OR (p_generation_id IS NOT NULL AND generation_id = p_generation_id))
  ORDER BY (quote ? 'charge') DESC, (status <> 'quoted') DESC, (id = p_charge_key) DESC
  LIMIT 1;
  IF FOUND AND v_existing.quote ? 'charge' THEN
    IF v_existing.user_id IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION 'LLM charge owner mismatch' USING ERRCODE='22023';
    END IF;
    IF v_existing.status <> 'pending' THEN
      SELECT to_jsonb(w.*) INTO v_wallet_json FROM billing.user_wallets w
      WHERE w.user_id=v_existing.user_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Settled LLM charge wallet missing'; END IF;
      RETURN jsonb_build_object('charge_status','already_charged',
        'wallet',v_wallet_json,'charge',billing.chat_charge_json(v_existing));
    END IF;
  ELSIF FOUND AND v_existing.status <> 'quoted' THEN
    RETURN billing.chat_archived_charge_result(v_existing, p_user_id);
  END IF;

  v_delivery_gate := billing.chat_delivery_billing_gate(p_charge_key);
  IF v_delivery_gate='user_stopped' THEN
    SELECT quote -> 'snapshot' INTO v_stop_snapshot FROM billing.usage_charges
      WHERE id=p_charge_key;
    -- The persisted accepted quote wins; no repricing from the current catalogue.
    v_metadata := v_metadata || v_stop_snapshot || jsonb_build_object(
      'billing_mode','fixed_tier','billing_trigger','user_stop',
      'chat_status','stream_interrupted','finish_reason','user_cancelled');
  END IF;
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
    AND v_delivery_gate <> 'user_stopped'
    AND (v_chat_status <> 'success' OR v_finish_reason <> 'stop');
  v_pending := CASE
    WHEN v_fixed THEN v_waiting_finish
    ELSE p_model_markup > 0
      AND (COALESCE(p_fallback_used, false) OR p_usage_cost_usd IS NULL)
  END;
  v_debit_key := p_charge_key::TEXT;

  SELECT * INTO v_existing
  FROM billing.usage_charges
  WHERE kind = 'chat_text'
    AND (id = p_charge_key OR (p_generation_id IS NOT NULL AND generation_id = p_generation_id))
  ORDER BY (quote ? 'charge') DESC, (status <> 'quoted') DESC, (id = p_charge_key) DESC
  LIMIT 1
  FOR UPDATE;
  v_has_existing := FOUND AND v_existing.quote ? 'charge';
  IF FOUND AND NOT v_has_existing THEN
    IF v_existing.status <> 'quoted' THEN
      RETURN billing.chat_archived_charge_result(v_existing, p_user_id);
    END IF;
    v_open_quote := v_existing.id = p_charge_key;
  END IF;

  IF v_has_existing AND v_existing.status <> 'pending' THEN
    SELECT to_jsonb(w.*) INTO v_wallet_json
    FROM billing.user_wallets w
    WHERE w.user_id = v_existing.user_id
    FOR UPDATE;
    RETURN jsonb_build_object(
      'charge_status', 'already_charged',
      'wallet', v_wallet_json,
      'charge', billing.chat_charge_json(v_existing)
    );
  END IF;

  v_quote_metadata := CASE
    WHEN NOT v_has_existing THEN '{}'::JSONB
    ELSE COALESCE(v_existing.quote -> 'charge' -> 'metadata', '{}'::JSONB)
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
    -- free_quota* stay for 1654 stale pending charges from before 6b-1q (newest 2026-09-29).
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
    WHEN v_delivery_gate = 'user_stopped' THEN 'user_stop'
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
      'charge', billing.chat_charge_json(v_existing)
    );
  END IF;

  v_stored := CASE
    WHEN NOT v_has_existing THEN v_metadata
    ELSE COALESCE(v_existing.quote -> 'charge' -> 'metadata', '{}'::JSONB) || (
      v_metadata
        - 'payable_credits' - 'fixed_deduction' - 'wallet_policy'
        - 'original_credits' - 'discount_rate' - 'discounted_exact'
        - 'vip_active' - 'vip_valid_until' - 'model_tier'
        - 'requires_vip' - 'fixed_deduction_category'
        - 'creator_reward'
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

  IF v_amount > 0 THEN
    PERFORM billing.lock_character_creator_wallets(p_user_id, v_stored->'creator_reward');
  END IF;

  IF v_has_existing THEN
    IF v_amount > 0 THEN
      -- 不足时异常冒泡，整笔回滚。pending 保持原状，由 sync 以后重试，不写 partial。
      v_debit_key := v_existing.id::TEXT;
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

    UPDATE billing.usage_charges
    SET generation_id = COALESCE(p_generation_id, generation_id),
        status = CASE
          WHEN v_non_billable_fixed THEN 'failed'
          WHEN v_amount = 0 THEN 'free'
          ELSE 'charged'
        END,
        charged_credits = v_amount,
        debit_ledger_id = COALESCE(v_ledger_id, debit_ledger_id),
        billing_mode = COALESCE(v_stored ->> 'billing_mode', billing_mode),
        quote = quote || jsonb_build_object('charge', (quote -> 'charge') || jsonb_build_object(
          'model_openrouter_id', p_model_openrouter_id,
          'model_display_name', p_model_display_name,
          'calculated_amount', v_amount,
          'fallback_used', false,
          'metadata', v_stored,
          'reconciled_at', now())),
        updated_at = now()
    WHERE id = v_existing.id
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

      v_status := CASE
        WHEN v_pending THEN 'pending'
        WHEN v_fixed AND v_non_billable_fixed THEN 'failed'
        WHEN v_amount = 0 THEN 'free'
        ELSE 'charged'
      END;
      v_recorded := v_amount;
      -- Only free-model failures are represented as failed spending details
      -- (formerly the BEFORE INSERT trigger on llm_usage_charges).
      IF p_model_markup = 0 AND COALESCE(v_stored ->> 'chat_status', 'success') <> 'success' THEN
        v_status := 'failed';
        v_recorded := 0;
        v_stored := v_stored || jsonb_build_object(
          'billing_mode', 'failed_free',
          'difference_reason', 'generation_failed'
        );
      END IF;
      v_stored := jsonb_build_object(
        'model_id', p_model_id, 'model_openrouter_id', p_model_openrouter_id,
        'model_display_name', p_model_display_name,
        'catalog_version', COALESCE(p_catalog_version, 0),
        'pricing_config_version', COALESCE(p_pricing_config_version, 0),
        'exchange_rate', p_exchange_rate::numeric(14,4), 'model_markup', p_model_markup::numeric(4,1),
        'initial_amount', v_recorded, 'calculated_amount', v_recorded, 'fallback_used', false,
        'metadata', v_stored, 'reconciled_at', NULL, 'charged_at', now());

      IF v_open_quote THEN
        UPDATE billing.usage_charges
        SET status = v_status,
            charged_credits = v_recorded,
            debit_ledger_id = v_ledger_id,
            generation_id = COALESCE(p_generation_id, generation_id),
            billing_mode = COALESCE(v_stored -> 'metadata' ->> 'billing_mode', billing_mode),
            quote = quote || jsonb_build_object('charge', v_stored),
            updated_at = now()
        WHERE id = p_charge_key
        RETURNING * INTO v_charge;
      ELSE
        INSERT INTO billing.usage_charges (
          id, user_id, kind, status, charged_credits, debit_ledger_id, generation_id,
          billing_mode, quote, created_at, updated_at
        ) VALUES (
          p_charge_key, p_user_id, 'chat_text', v_status, v_recorded, v_ledger_id, p_generation_id,
          v_stored -> 'metadata' ->> 'billing_mode', jsonb_build_object('charge', v_stored), now(), now()
        ) RETURNING * INTO v_charge;
      END IF;
    EXCEPTION
      WHEN unique_violation THEN
        -- This subtransaction has rolled back its debit. Return only durable proof of the winner.
        SELECT * INTO v_existing
        FROM billing.usage_charges
        WHERE kind = 'chat_text'
          AND (id = p_charge_key OR (p_generation_id IS NOT NULL AND generation_id = p_generation_id))
        ORDER BY (quote ? 'charge') DESC, (status <> 'quoted') DESC, (id = p_charge_key) DESC
        LIMIT 1;
        IF FOUND AND v_existing.quote ? 'charge' THEN
          IF v_existing.user_id IS DISTINCT FROM p_user_id THEN
            RAISE EXCEPTION 'LLM charge owner mismatch' USING ERRCODE='22023';
          END IF;
          SELECT to_jsonb(w.*) INTO v_wallet_json FROM billing.user_wallets w
          WHERE w.user_id=v_existing.user_id;
          IF NOT FOUND THEN RAISE EXCEPTION 'Existing LLM charge wallet missing'; END IF;
          RETURN jsonb_build_object(
            'charge_status',CASE WHEN v_existing.status='pending' THEN 'already_pending' ELSE 'already_charged' END,
            'wallet',v_wallet_json,'charge',billing.chat_charge_json(v_existing));
        ELSIF FOUND AND v_existing.status <> 'quoted' THEN
          RETURN billing.chat_archived_charge_result(v_existing, p_user_id);
        END IF;
        -- An unrelated uniqueness failure is an error, not a successful empty result.
        RAISE;
    END;
  END IF;

  PERFORM billing.grant_character_creator_reward(v_charge);

  RETURN jsonb_build_object(
    'charge_status', v_charge.status,
    'wallet', v_wallet_json,
    'charge', billing.chat_charge_json(v_charge)
  );
END;
$fn$$def_charge$;
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'billing.charge_llm_usage(uuid,text,uuid,text,text,text,integer,integer,numeric,numeric,numeric,numeric,boolean,jsonb)'::regprocedure;
    IF v_md5 <> 'e27bb6f2e5a63910c5c9539f5e1fcf8b' THEN RAISE EXCEPTION 'p6b1c-charge: charge has md5 % after the switch', v_md5; END IF;
    v_done := v_done + 1;
  ELSIF v_md5 <> 'e27bb6f2e5a63910c5c9539f5e1fcf8b' THEN
    RAISE EXCEPTION 'p6b1c-charge: billing.charge_llm_usage(uuid,text,uuid,text,text,text,integer,integer,numeric,numeric,numeric,numeric,boolean,jsonb) drifted (md5 %), refusing', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'billing.reconcile_llm_usage(uuid,numeric,numeric,jsonb)'::regprocedure;
  IF v_md5 = '49318c359afc4167c4debd0a9f9173d4' THEN
    EXECUTE $def_reconcile$CREATE OR REPLACE FUNCTION billing.reconcile_llm_usage(p_charge_key uuid, p_usage_cost_usd numeric, p_calculated_amount numeric, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  -- db reorg 6b-1c: reads and writes billing.usage_charges; only rows with a charge detail can be reconciled.
  v_charge billing.usage_charges;
  v_wallet billing.user_wallets;
  v_markup NUMERIC;
  v_target NUMERIC(14,1);
  v_delta NUMERIC(14,1);
  v_applied NUMERIC(14,1) := 0;
  v_bonus NUMERIC(14,1) := 0;
  v_main NUMERIC(14,1) := 0;
  v_net_bonus_debit NUMERIC(14,1);
  v_net_main_debit NUMERIC(14,1);
  v_metadata JSONB;
BEGIN
  SELECT * INTO v_charge
  FROM billing.usage_charges
  WHERE id = p_charge_key AND kind = 'chat_text' AND quote ? 'charge'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LLM usage charge not found: %', p_charge_key
      USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_wallet
  FROM billing.user_wallets
  WHERE user_id = v_charge.user_id
  FOR UPDATE;

  v_markup := (v_charge.quote -> 'charge' ->> 'model_markup')::NUMERIC;
  v_target := CASE
    WHEN v_markup = 0 THEN 0
    ELSE round(GREATEST(COALESCE(p_calculated_amount, 0), 0), 1)
  END;
  v_delta := v_target - v_charge.charged_credits;

  IF v_delta > 0 THEN
    v_applied := LEAST(v_delta, v_wallet.main_credits + v_wallet.bonus_credits);
    v_bonus := LEAST(v_wallet.bonus_credits, v_applied);
    v_main := v_applied - v_bonus;
    IF v_applied > 0 THEN
      UPDATE billing.user_wallets
      SET bonus_credits = bonus_credits - v_bonus,
          main_credits = main_credits - v_main,
          updated_at = now()
      WHERE user_id = v_charge.user_id
      RETURNING * INTO v_wallet;

      INSERT INTO billing.wallet_ledger(
        user_id, entry_type, amount, main_delta, bonus_delta,
        balance_main, balance_bonus, reference_type, reference_id, metadata
      ) VALUES (
        v_charge.user_id, 'adjustment', -v_applied, -v_main, -v_bonus,
        v_wallet.main_credits, v_wallet.bonus_credits,
        'llm_usage', v_charge.id::TEXT,
        COALESCE(p_metadata, '{}'::JSONB) || jsonb_build_object(
          'reason', 'late_usage_reconcile', 'target_amount', v_target
        )
      );
    END IF;
  ELSIF v_delta < 0 THEN
    v_applied := -v_delta;
    SELECT
      GREATEST(-COALESCE(sum(main_delta), 0), 0),
      GREATEST(-COALESCE(sum(bonus_delta), 0), 0)
    INTO v_net_main_debit, v_net_bonus_debit
    FROM billing.wallet_ledger
    WHERE reference_type = 'llm_usage'
      AND reference_id = v_charge.id::TEXT;

    v_bonus := LEAST(v_applied, v_net_bonus_debit);
    v_main := v_applied - v_bonus;
    UPDATE billing.user_wallets
    SET bonus_credits = bonus_credits + v_bonus,
        main_credits = main_credits + v_main,
        updated_at = now()
    WHERE user_id = v_charge.user_id
    RETURNING * INTO v_wallet;

    INSERT INTO billing.wallet_ledger(
      user_id, entry_type, amount, main_delta, bonus_delta,
      balance_main, balance_bonus, reference_type, reference_id, metadata
    ) VALUES (
      v_charge.user_id, 'refund', v_applied, v_main, v_bonus,
      v_wallet.main_credits, v_wallet.bonus_credits,
      'llm_usage', v_charge.id::TEXT,
      COALESCE(p_metadata, '{}'::JSONB) || jsonb_build_object(
        'reason', 'late_usage_reconcile', 'target_amount', v_target
      )
    );
    v_applied := -v_applied;
  END IF;

  v_metadata := COALESCE(v_charge.quote -> 'charge' -> 'metadata', '{}'::JSONB) || COALESCE(p_metadata, '{}'::JSONB);
  UPDATE billing.usage_charges
  SET charged_credits = charged_credits + v_applied,
      status = CASE
        WHEN v_markup = 0 THEN 'free'
        WHEN charged_credits + v_applied = v_target THEN 'reconciled'
        ELSE 'partial'
      END,
      billing_mode = COALESCE(v_metadata ->> 'billing_mode', billing_mode),
      quote = quote || jsonb_build_object('charge', (quote -> 'charge') || jsonb_build_object(
        'calculated_amount', v_target,
        'fallback_used', false,
        'metadata', v_metadata,
        'reconciled_at', now())),
      updated_at = now()
  WHERE id = v_charge.id
  RETURNING * INTO v_charge;

  RETURN jsonb_build_object(
    'reconcile_status', v_charge.status,
    'wallet', to_jsonb(v_wallet),
    'charge', billing.chat_charge_json(v_charge)
  );
END;
$fn$$def_reconcile$;
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'billing.reconcile_llm_usage(uuid,numeric,numeric,jsonb)'::regprocedure;
    IF v_md5 <> '6633b10c4381245abb9baa381c8eca08' THEN RAISE EXCEPTION 'p6b1c-charge: reconcile has md5 % after the switch', v_md5; END IF;
    v_done := v_done + 1;
  ELSIF v_md5 <> '6633b10c4381245abb9baa381c8eca08' THEN
    RAISE EXCEPTION 'p6b1c-charge: billing.reconcile_llm_usage(uuid,numeric,numeric,jsonb) drifted (md5 %), refusing', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'billing.refund_llm_usage_charge(uuid,text)'::regprocedure;
  IF v_md5 = '42a06a0793b7ff5858624b97a1cfef1f' THEN
    EXECUTE $def_refund$CREATE OR REPLACE FUNCTION billing.refund_llm_usage_charge(p_charge_key uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  -- db reorg 6b-1c: reads and writes billing.usage_charges; a row without charge detail is not refundable here.
  v_charge billing.usage_charges;
  v_debit_key TEXT;
  v_ledger_key TEXT;
  v_refund JSONB;
  v_wallet_json JSONB;
  v_status TEXT;
  v_metadata JSONB;
BEGIN
  IF p_charge_key IS NULL THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_charge
  FROM billing.usage_charges
  WHERE id = p_charge_key AND kind = 'chat_text' AND quote ? 'charge'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'status', 'not_found');
  END IF;

  SELECT to_jsonb(w.*) INTO v_wallet_json
  FROM billing.user_wallets w
  WHERE w.user_id = v_charge.user_id;

  IF v_charge.charged_credits <= 0 OR v_charge.debit_ledger_id IS NULL
     OR v_charge.status IN ('pending', 'free', 'failed') THEN
    RETURN jsonb_build_object(
      'ok', true,
      'status', 'not_debited',
      'wallet', v_wallet_json,
      'charge', billing.chat_charge_json(v_charge)
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
      'charge', billing.chat_charge_json(v_charge)
    );
  END IF;

  PERFORM billing.lock_character_creator_wallets(v_charge.user_id, v_charge.quote->'charge'->'metadata'->'creator_reward');
  v_refund := billing.refund_wallet_debit(
    'llm-refund:' || v_debit_key,
    v_debit_key,
    'llm_usage'
  );
  v_status := v_refund ->> 'status';
  PERFORM billing.reverse_character_creator_reward(p_charge_key);
  v_wallet_json := v_refund -> 'wallet';

  v_metadata := COALESCE(v_charge.quote -> 'charge' -> 'metadata', '{}'::JSONB) || jsonb_strip_nulls(jsonb_build_object(
    'compensation_status', 'refunded',
    'business_status', 'refunded',
    'refund_key', v_refund ->> 'refund_key',
    'refund_of', v_debit_key,
    'compensation_reason', NULLIF(btrim(COALESCE(p_reason, '')), '')
  ));
  UPDATE billing.usage_charges
  SET billing_mode = COALESCE(v_metadata ->> 'billing_mode', billing_mode),
      quote = quote || jsonb_build_object('charge', (quote -> 'charge') || jsonb_build_object(
        'metadata', v_metadata,
        'reconciled_at', now())),
      updated_at = now()
  WHERE id = p_charge_key
  RETURNING * INTO v_charge;

  RETURN jsonb_build_object(
    'ok', true,
    'status', v_status,
    'wallet', v_wallet_json,
    'charge', billing.chat_charge_json(v_charge),
    'split', v_refund -> 'split'
  );
END;
$fn$$def_refund$;
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'billing.refund_llm_usage_charge(uuid,text)'::regprocedure;
    IF v_md5 <> 'b1b153d59a17b7dab85fd725573eb563' THEN RAISE EXCEPTION 'p6b1c-charge: refund has md5 % after the switch', v_md5; END IF;
    v_done := v_done + 1;
  ELSIF v_md5 <> 'b1b153d59a17b7dab85fd725573eb563' THEN
    RAISE EXCEPTION 'p6b1c-charge: billing.refund_llm_usage_charge(uuid,text) drifted (md5 %), refusing', v_md5;
  END IF;
  RAISE NOTICE 'p6b1c-charge: charge shape matches on % recent charges; % functions now write usage_charges', v_rows, v_done;
END
$switch$;
