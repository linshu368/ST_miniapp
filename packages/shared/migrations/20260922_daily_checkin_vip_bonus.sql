-- 20260922_daily_checkin_vip_bonus.sql
-- domain: miniapp_features + app_core + billing
--
-- T3 forward-fix：签到基础额收敛为 60，有效 VIP 在同一笔 grant 中再加同等基础额。
-- 不改 20260921_* 已 apply 文件。不新建表。不收回 claim_daily_checkin 的历史 anon EXECUTE。
--
-- 权威发放值：app_core.runtime_config.miniapp_daily_checkin_bonus_credits。
-- 权限：同一 now() 快照下 billing.vip_memberships.valid_until > now()。
--
-- 前置：20260921_feature_free_trial_checkin_reminder.sql 已 apply；
--       billing.vip_memberships 与 billing.grant_bonus_credits 已存在。
-- 锁：单行 runtime_config UPDATE；CREATE OR REPLACE FUNCTION 短暂锁函数，不改表、不建索引。
-- 执行：GitHub Actions Database Migration，environment=test，一次一个文件。
--       本文件未获明确批准不得 apply。Production 当前签到值未核，禁止对 Production 执行。
-- 恢复：已发放的 60/120 不 claw back。若需停用新加成，另写 forward-fix 把函数体
--       恢复为 vip 加成 0，并把该 key 设回 apply 前 NOTICE 里的旧值（test 采集为 40）。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  v_prev JSONB;
BEGIN
  IF to_regclass('app_core.runtime_config') IS NULL
     OR to_regclass('billing.vip_memberships') IS NULL
     OR to_regclass('miniapp_features.daily_checkins') IS NULL THEN
    RAISE EXCEPTION '20260922_daily_checkin_vip_bonus: required tables missing';
  END IF;
  IF to_regprocedure('miniapp_features.claim_daily_checkin(uuid)') IS NULL THEN
    RAISE EXCEPTION '20260922_daily_checkin_vip_bonus: claim_daily_checkin missing';
  END IF;
  IF to_regprocedure('billing.grant_bonus_credits(uuid,numeric,text,text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '20260922_daily_checkin_vip_bonus: grant_bonus_credits missing';
  END IF;

  SELECT value INTO v_prev
  FROM app_core.runtime_config
  WHERE key = 'miniapp_daily_checkin_bonus_credits';
  RAISE NOTICE '20260922_daily_checkin_vip_bonus: previous base reward = %', v_prev;
END;
$$;

INSERT INTO app_core.runtime_config AS config (
  key,
  value,
  description,
  version,
  updated_at,
  text_value
) VALUES (
  'miniapp_daily_checkin_bonus_credits',
  '60'::jsonb,
  '每次签到的基础专项星尘。有效 VIP 在同一笔领取中再加同等数量。',
  1,
  now(),
  NULL
)
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  description = EXCLUDED.description,
  version = config.version + 1,
  updated_at = now(),
  text_value = NULL;

CREATE OR REPLACE FUNCTION miniapp_features.claim_daily_checkin(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_wallet billing.user_wallets;
  v_last_claimed_at TIMESTAMPTZ;
  v_base INTEGER;
  v_vip INTEGER;
  v_total INTEGER;
  v_ledger_id UUID;
  v_grant RECORD;
  v_claimed_at TIMESTAMPTZ := now();
  v_membership billing.vip_memberships;
  v_vip_active BOOLEAN := false;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'daily check-in user is required'
      USING ERRCODE = '22023';
  END IF;

  -- 与 T2 使用同一把用户级事务锁，避免两版函数并存时各锁各的。
  PERFORM pg_advisory_xact_lock(74210021, hashtext(p_user_id::text));

  SELECT *
  INTO v_membership
  FROM billing.vip_memberships
  WHERE user_id = p_user_id
  FOR UPDATE;

  v_vip_active := FOUND AND v_membership.valid_until > v_claimed_at;

  SELECT claimed_at
  INTO v_last_claimed_at
  FROM miniapp_features.daily_checkins
  WHERE user_id = p_user_id
  ORDER BY claimed_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND AND v_last_claimed_at > v_claimed_at - interval '24 hours' THEN
    RAISE EXCEPTION 'daily check-in is not ready: %', p_user_id
      USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(
    floor(
      COALESCE(
        (
          SELECT NULLIF(value #>> '{}', '')::numeric
          FROM app_core.runtime_config
          WHERE key = 'miniapp_daily_checkin_bonus_credits'
        ),
        60
      )
    )::integer,
    60
  )
  INTO v_base;

  IF v_base <= 0 THEN
    RAISE EXCEPTION 'daily check-in reward must be positive: %', v_base
      USING ERRCODE = '22023';
  END IF;

  v_vip := CASE WHEN v_vip_active THEN v_base ELSE 0 END;
  v_total := v_base + v_vip;

  SELECT * INTO v_grant
  FROM billing.grant_bonus_credits(
    p_user_id,
    v_total,
    'checkin_bonus',
    'daily_checkin',
    p_user_id::text,
    jsonb_build_object(
      'claimed_at', v_claimed_at,
      'base_reward_credits', v_base,
      'vip_reward_credits', v_vip,
      'vip_active', v_vip_active,
      'vip_valid_until', CASE WHEN v_vip_active THEN v_membership.valid_until ELSE NULL END
    )
  );
  v_ledger_id := v_grant.o_ledger_id;
  v_wallet := v_grant.o_wallet;

  INSERT INTO miniapp_features.daily_checkins (
    user_id,
    reward_credits,
    claimed_at
  ) VALUES (
    p_user_id,
    v_total,
    v_claimed_at
  );

  RETURN jsonb_build_object(
    'wallet', to_jsonb(v_wallet),
    'checkin', jsonb_build_object(
      'claimed_at', v_claimed_at,
      'next_claim_at', v_claimed_at + interval '24 hours',
      'reward_credits', v_total,
      'base_reward_credits', v_base,
      'vip_reward_credits', v_vip,
      'vip_active', v_vip_active,
      'wallet_ledger_id', v_ledger_id
    )
  );
END;
$$;

-- 保留历史 anon/authenticated EXECUTE。这是已知债务，本文件不收回。
GRANT EXECUTE ON FUNCTION miniapp_features.claim_daily_checkin(UUID)
  TO postgres, service_role, anon, authenticated;

COMMENT ON FUNCTION miniapp_features.claim_daily_checkin(UUID) IS
  '每日签到。用户级锁防首次并发。基础额读 runtime_config；有效 VIP 再加同等基础额，一次进入专项钱包。';

DO $$
DECLARE
  v_cfg TEXT[];
  v_src TEXT;
  v_value JSONB;
BEGIN
  SELECT value INTO v_value
  FROM app_core.runtime_config
  WHERE key = 'miniapp_daily_checkin_bonus_credits';
  IF v_value IS DISTINCT FROM '60'::jsonb THEN
    RAISE EXCEPTION 'postflight: checkin base reward is not 60';
  END IF;

  SELECT proconfig, pg_get_functiondef(oid) INTO v_cfg, v_src
  FROM pg_proc
  WHERE oid = 'miniapp_features.claim_daily_checkin(uuid)'::regprocedure;

  IF v_cfg IS NULL OR NOT ('search_path=pg_catalog' = ANY (v_cfg)) THEN
    RAISE EXCEPTION 'postflight: claim_daily_checkin search_path is not pg_catalog';
  END IF;
  IF position('v_vip' IN v_src) = 0
     OR position('grant_bonus_credits' IN v_src) = 0 THEN
    RAISE EXCEPTION 'postflight: claim_daily_checkin is missing the VIP bonus grant';
  END IF;
  IF NOT has_function_privilege('anon', 'miniapp_features.claim_daily_checkin(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'miniapp_features.claim_daily_checkin(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'miniapp_features.claim_daily_checkin(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postflight: claim_daily_checkin lost a historical or service_role EXECUTE grant';
  END IF;
END;
$$;

COMMIT;
NOTIFY pgrst, 'reload schema';
