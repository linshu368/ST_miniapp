-- domain: billing
-- 状态面板「立即更新」按次收费：所有人每次 6 星尘，先扣专项（bonus）再扣通用（main）。
-- 一次手动更新 = billing.usage_charges 一行（kind = 'status_refresh'，id = charge id，subject_id = 会话 id），
-- 同一事务经 billing.apply_wallet_debit 写 billing.wallet_ledger（entry_type / reference_type = 'status_refresh'，
-- reference_id = charge id，debit_key = 'status_refresh:' || charge id）。业务表不存价格。
--
-- 只扩展，不改已有行：
--   1. wallet_ledger_entry_type_check 追加 status_refresh（保持 NOT VALID，不扫历史流水）；
--   2. usage_charges_kind_check 追加 status_refresh（先 NOT VALID 提交，再在锁更轻的单独语句里 VALIDATE：
--      usage_charges 生产约 46 万行，校验不能拿着 ACCESS EXCLUSIVE 扫表、挡住聊天扣费写入）；
--   3. apply_wallet_debit 的类型白名单追加 status_refresh（只替换已知那一行；函数体其余部分、OID、属性、权限不变）；
--   4. 新函数 billing.charge_status_refresh(uuid,uuid,uuid,numeric)，只授 service_role。
-- 2026-11-26 生产实测：白名单为 ('chat_debit', 'image_generation', 'media_plaza_video_reserve')，
-- wallet_ledger_entry_type_check 为 NOT VALID，usage_charges_kind_check 为 validated 的 4 个值。
--
-- 发布：TEST 单文件 → TEST 验证 → 生产单文件 → 发布调用新函数的后端。旧后端不调新函数，先执行无影响。
-- 重跑：每一步已完成即跳过；VALIDATE 重复执行无害。
-- 验证：bash scripts/test-status-refresh-charge-migration.sh
-- 回滚（forward-fix 优先）：停止收费 = 回滚后端即可（旧后端不调新函数）。确需移除函数：
--   DROP FUNCTION billing.charge_status_refresh(uuid,uuid,uuid,numeric);
-- 约束与白名单的扩展保留：只是多允许一个值；已有的 status_refresh 流水是资金审计事实，不删。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1. 流水类型：保留现有表达式与注释，只追加 status_refresh，仍为 NOT VALID。
DO $ledger_types$
DECLARE
  v_expression TEXT;
  v_comment TEXT;
  v_column SMALLINT;
BEGIN
  SELECT attnum INTO v_column FROM pg_attribute
    WHERE attrelid = 'billing.wallet_ledger'::regclass AND attname = 'entry_type' AND NOT attisdropped;
  SELECT pg_get_expr(conbin, conrelid), obj_description(oid, 'pg_constraint')
    INTO v_expression, v_comment
    FROM pg_constraint
    WHERE conrelid = 'billing.wallet_ledger'::regclass
      AND conname = 'wallet_ledger_entry_type_check' AND contype = 'c'
      AND conkey = ARRAY[v_column] AND NOT convalidated AND conislocal AND NOT connoinherit;
  IF v_expression IS NULL THEN
    RAISE EXCEPTION 'status_refresh_charge: wallet type constraint differs';
  END IF;
  IF strpos(v_expression, '''status_refresh''::text') > 0 THEN
    RETURN;
  END IF;
  ALTER TABLE billing.wallet_ledger DROP CONSTRAINT wallet_ledger_entry_type_check;
  EXECUTE format(
    'ALTER TABLE billing.wallet_ledger ADD CONSTRAINT wallet_ledger_entry_type_check CHECK ((%s) OR entry_type = %L) NOT VALID',
    v_expression, 'status_refresh');
  IF v_comment IS NOT NULL THEN
    EXECUTE format('COMMENT ON CONSTRAINT wallet_ledger_entry_type_check ON billing.wallet_ledger IS %L', v_comment);
  END IF;
END;
$ledger_types$;

-- 2. 计费记录类型：只接受已知的 4 值原形；先 NOT VALID，事务提交后再 VALIDATE。
DO $charge_kinds$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
    WHERE conrelid = 'billing.usage_charges'::regclass AND conname = 'usage_charges_kind_check' AND contype = 'c';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'status_refresh_charge: usage charge kind constraint missing';
  END IF;
  IF strpos(v_def, '''status_refresh''::text') > 0 THEN
    RETURN;
  END IF;
  IF v_def <> 'CHECK ((kind = ANY (ARRAY[''chat_text''::text, ''chat_voice''::text, ''plaza_image''::text, ''plaza_video''::text])))' THEN
    RAISE EXCEPTION 'status_refresh_charge: usage charge kind constraint differs: %', v_def;
  END IF;
  ALTER TABLE billing.usage_charges DROP CONSTRAINT usage_charges_kind_check;
  ALTER TABLE billing.usage_charges ADD CONSTRAINT usage_charges_kind_check
    CHECK (kind IN ('chat_text', 'chat_voice', 'plaza_image', 'plaza_video', 'status_refresh')) NOT VALID;
END;
$charge_kinds$;

-- 3. 扣费函数白名单：只替换已知那一行，不用旧的完整定义覆盖现行函数。
DO $guard$
DECLARE
  v_oid OID := to_regprocedure('billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)');
  v_before RECORD;
  v_after RECORD;
  v_definition TEXT;
  v_expected_body TEXT;
  v_old CONSTANT TEXT := $old$IF p_entry_type IS NULL OR p_entry_type NOT IN ('chat_debit', 'image_generation', 'media_plaza_video_reserve') THEN$old$;
  v_new CONSTANT TEXT := $new$IF p_entry_type IS NULL OR p_entry_type NOT IN ('chat_debit', 'image_generation', 'media_plaza_video_reserve', 'status_refresh') THEN$new$;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'status_refresh_charge: wallet debit function missing';
  END IF;
  SELECT proowner, proacl, proconfig, prosecdef, provolatile, proparallel,
    proisstrict, proleakproof, procost, prorows, prosrc
  INTO v_before FROM pg_proc WHERE oid = v_oid;
  IF NOT v_before.prosecdef OR v_before.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN
    RAISE EXCEPTION 'status_refresh_charge: unexpected wallet security';
  END IF;

  v_definition := pg_get_functiondef(v_oid);
  IF length(v_definition) - length(replace(v_definition, v_old, '')) = length(v_old)
     AND strpos(v_definition, v_new) = 0 THEN
    v_expected_body := replace(v_before.prosrc, v_old, v_new);
    EXECUTE replace(v_definition, v_old, v_new);
  ELSIF length(v_definition) - length(replace(v_definition, v_new, '')) = length(v_new)
     AND strpos(v_definition, v_old) = 0 THEN
    v_expected_body := v_before.prosrc;
  ELSE
    RAISE EXCEPTION 'status_refresh_charge: unknown or duplicate entry guard';
  END IF;

  IF to_regprocedure('billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)')::OID IS DISTINCT FROM v_oid THEN
    RAISE EXCEPTION 'status_refresh_charge: function identity changed';
  END IF;
  SELECT proowner, proacl, proconfig, prosecdef, provolatile, proparallel,
    proisstrict, proleakproof, procost, prorows, prosrc
  INTO v_after FROM pg_proc WHERE oid = v_oid;
  IF v_after.prosrc IS DISTINCT FROM v_expected_body
     OR (to_jsonb(v_after) - 'prosrc') IS DISTINCT FROM (to_jsonb(v_before) - 'prosrc') THEN
    RAISE EXCEPTION 'status_refresh_charge: wallet body or attributes changed';
  END IF;
END;
$guard$;

-- 4. 一次手动更新的扣费。后端只在这次更新真记下了新内容时调用；charge id 由后端每次请求新生成。
--    余额不足（含被聊天预留占住，由 protect_chat_reserved_balance 触发器拦下）→ 记一行 failed，不扣钱。
CREATE OR REPLACE FUNCTION billing.charge_status_refresh(
  p_charge_id UUID,
  p_user_id UUID,
  p_session_id UUID,
  p_amount NUMERIC
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_existing billing.usage_charges%ROWTYPE;
  v_amount NUMERIC(14,1);
  v_debit JSONB;
  v_main NUMERIC(14,1);
  v_bonus NUMERIC(14,1);
  v_inserted INTEGER;
BEGIN
  v_amount := round(COALESCE(p_amount, 0), 1);
  IF p_charge_id IS NULL OR p_user_id IS NULL OR p_session_id IS NULL
     OR v_amount <= 0 OR v_amount <> trunc(v_amount) THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_existing FROM billing.usage_charges WHERE id = p_charge_id;
  IF FOUND THEN
    IF v_existing.user_id IS DISTINCT FROM p_user_id OR v_existing.kind <> 'status_refresh' THEN
      RAISE EXCEPTION 'CHARGE_ID_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object(
      'status', CASE WHEN v_existing.status = 'charged' THEN 'already_charged' ELSE 'insufficient' END,
      'ledger_id', v_existing.debit_ledger_id,
      'split', v_existing.quote -> 'charge'
    );
  END IF;

  BEGIN
    v_debit := billing.apply_wallet_debit(
      p_user_id,
      'status_refresh:' || p_charge_id::text,
      'main_then_bonus',
      v_amount,
      'status_refresh',
      'status_refresh',
      p_charge_id::text,
      '{}'::jsonb
    );
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'TOTAL_CREDITS_INSUFFICIENT' THEN
      RAISE;
    END IF;
    INSERT INTO billing.usage_charges (
      id, user_id, kind, subject_id, status, billing_mode, wallet_policy,
      quoted_credits, charged_credits, quote, settled_at
    ) VALUES (
      p_charge_id, p_user_id, 'status_refresh', p_session_id, 'failed', 'paid', 'main_then_bonus',
      v_amount, 0, jsonb_build_object('charge', jsonb_build_object('error_code', SQLERRM)), now()
    ) ON CONFLICT (id) DO NOTHING;
    RETURN jsonb_build_object('status', 'insufficient');
  END;

  v_main := COALESCE((v_debit #>> '{split,main_credits}')::NUMERIC, 0);
  v_bonus := COALESCE((v_debit #>> '{split,bonus_credits}')::NUMERIC, 0);
  INSERT INTO billing.usage_charges (
    id, user_id, kind, subject_id, status, billing_mode, wallet_policy,
    quoted_credits, charged_credits, debit_ledger_id, quote, settled_at
  ) VALUES (
    p_charge_id, p_user_id, 'status_refresh', p_session_id, 'charged', 'paid', 'main_then_bonus',
    v_amount, v_amount, (v_debit ->> 'ledger_id')::UUID,
    jsonb_build_object('charge', jsonb_build_object('main_credits', v_main, 'bonus_credits', v_bonus)),
    now()
  ) ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  RETURN jsonb_build_object(
    -- 并发重复调用同一 charge id：流水由 debit_key 去重，这里只认先写进去的那一行
    'status', CASE WHEN v_inserted = 1 THEN 'charged' ELSE 'already_charged' END,
    'ledger_id', v_debit ->> 'ledger_id',
    'split', jsonb_build_object('main_credits', v_main, 'bonus_credits', v_bonus)
  );
END;
$$;

REVOKE ALL ON FUNCTION billing.charge_status_refresh(UUID, UUID, UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.charge_status_refresh(UUID, UUID, UUID, NUMERIC) TO service_role;
COMMENT ON FUNCTION billing.charge_status_refresh(UUID, UUID, UUID, NUMERIC) IS
  '状态面板立即更新按次扣费：usage_charges 一行（kind=status_refresh）+ apply_wallet_debit（专项优先）。charge id 幂等；余额不足记 failed 不扣。';

COMMIT;

-- 2b. 校验计费记录类型约束（SHARE UPDATE EXCLUSIVE，不挡读写）。
SET lock_timeout = '5s';
SET statement_timeout = '300s';
ALTER TABLE billing.usage_charges VALIDATE CONSTRAINT usage_charges_kind_check;

-- 5. 尾检
DO $postflight$
DECLARE
  v_fn OID := to_regprocedure('billing.charge_status_refresh(uuid,uuid,uuid,numeric)');
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'billing.wallet_ledger'::regclass AND conname = 'wallet_ledger_entry_type_check'
      AND strpos(pg_get_constraintdef(oid), '''status_refresh''::text') > 0
  ) THEN
    RAISE EXCEPTION 'postflight: wallet_ledger_entry_type_check lacks status_refresh';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'billing.usage_charges'::regclass AND conname = 'usage_charges_kind_check'
      AND convalidated AND strpos(pg_get_constraintdef(oid), '''status_refresh''::text') > 0
  ) THEN
    RAISE EXCEPTION 'postflight: usage_charges_kind_check lacks status_refresh or is not validated';
  END IF;
  IF strpos(
       pg_get_functiondef('billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)'::regprocedure),
       $guard$NOT IN ('chat_debit', 'image_generation', 'media_plaza_video_reserve', 'status_refresh')$guard$) = 0 THEN
    RAISE EXCEPTION 'postflight: apply_wallet_debit does not allow status_refresh';
  END IF;
  IF strpos(
       pg_get_functiondef('billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)'::regprocedure),
       'v_bonus := LEAST(v_wallet.bonus_credits, v_amount);') = 0 THEN
    RAISE EXCEPTION 'postflight: apply_wallet_debit lost the bonus-first split';
  END IF;
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'postflight: charge_status_refresh missing';
  END IF;
  IF NOT (SELECT prosecdef AND proconfig = ARRAY['search_path=pg_catalog'] FROM pg_proc WHERE oid = v_fn) THEN
    RAISE EXCEPTION 'postflight: charge_status_refresh security differs';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'postflight: charge_status_refresh privileges differ';
  END IF;
END;
$postflight$;

NOTIFY pgrst, 'reload schema';
