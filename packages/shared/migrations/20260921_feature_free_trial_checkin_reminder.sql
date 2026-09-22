-- 20260921_feature_free_trial_checkin_reminder.sql
-- domain: billing + miniapp_features
--
-- T2 第 4/4 文件：
--   媒体免费次数公共原语（不接入语音/图片领域表）
--   签到用户级锁 + 可读 VIP（不改奖励 40）
--   基于 business_key 的 VIP 提醒插入（不发推送、不建 cron）
-- 前置：20260921_vip_billing_schema.sql
-- 跨 schema：reminder 读 billing.vip_memberships，写 miniapp_features.notifications。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF to_regclass('billing.feature_free_trials') IS NULL
     OR to_regclass('billing.vip_memberships') IS NULL THEN
    RAISE EXCEPTION '20260921_feature_free_trial_checkin_reminder: run schema migration first';
  END IF;
  IF to_regprocedure('miniapp_features.claim_daily_checkin(uuid)') IS NULL THEN
    RAISE EXCEPTION '20260921_feature_free_trial_checkin_reminder: claim_daily_checkin missing';
  END IF;
  IF to_regprocedure('billing.grant_bonus_credits(uuid,numeric,text,text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '20260921_feature_free_trial_checkin_reminder: grant_bonus_credits missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'miniapp_features'
      AND table_name = 'notifications'
      AND column_name = 'business_key'
  ) THEN
    RAISE EXCEPTION '20260921_feature_free_trial_checkin_reminder: notifications.business_key missing';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION billing.reclaim_expired_feature_free_trials(
  p_user_id UUID,
  p_feature TEXT
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_user_id IS NULL OR p_feature NOT IN ('voice', 'basic_image') THEN
    RAISE EXCEPTION 'FEATURE_FREE_TRIAL_INVALID_STATE'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE billing.feature_free_trials
  SET
    status = 'released',
    released_at = now(),
    updated_at = now()
  WHERE user_id = p_user_id
    AND feature = p_feature
    AND status = 'reserved'
    AND reserved_until < now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION billing.reserve_feature_free_trial(
  p_user_id UUID,
  p_feature TEXT,
  p_reference_id TEXT,
  p_ttl_seconds INTEGER DEFAULT 900
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_reference TEXT;
  v_ttl INTEGER;
  v_existing billing.feature_free_trials;
  v_ordinal INTEGER;
  v_row billing.feature_free_trials;
  v_used INTEGER;
  v_reserved INTEGER;
BEGIN
  v_reference := btrim(COALESCE(p_reference_id, ''));
  v_ttl := LEAST(GREATEST(COALESCE(p_ttl_seconds, 900), 30), 3600);

  IF p_user_id IS NULL OR p_feature NOT IN ('voice', 'basic_image') OR v_reference = '' THEN
    RAISE EXCEPTION 'FEATURE_FREE_TRIAL_INVALID_STATE'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(74210022, hashtext(p_user_id::text || ':' || p_feature));
  PERFORM billing.reclaim_expired_feature_free_trials(p_user_id, p_feature);

  SELECT *
  INTO v_existing
  FROM billing.feature_free_trials
  WHERE reference_id = v_reference
  FOR UPDATE;

  IF v_existing.id IS NOT NULL AND v_existing.user_id = p_user_id AND v_existing.feature = p_feature THEN
    IF v_existing.status IN ('reserved', 'consumed') THEN
      SELECT
        count(*) FILTER (WHERE status = 'consumed'),
        count(*) FILTER (WHERE status = 'reserved')
      INTO v_used, v_reserved
      FROM billing.feature_free_trials
      WHERE user_id = p_user_id AND feature = p_feature AND status IN ('reserved', 'consumed');

      RETURN jsonb_build_object(
        'ok', true,
        'status', CASE WHEN v_existing.status = 'consumed' THEN 'already_consumed' ELSE 'already_reserved' END,
        'fact', to_jsonb(v_existing),
        'quota', jsonb_build_object(
          'feature', p_feature,
          'free_trial_limit', 3,
          'free_trials_used', v_used,
          'free_trials_reserved', v_reserved,
          'free_trials_remaining', 3 - v_used - v_reserved,
          'next_trial_ordinal', NULL
        )
      );
    END IF;
  ELSIF v_existing.id IS NOT NULL THEN
    RAISE EXCEPTION 'FEATURE_FREE_TRIAL_CONFLICT'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT MIN(ordinal)
  INTO v_ordinal
  FROM generate_series(1, 3) AS ordinal
  WHERE ordinal NOT IN (
    SELECT fft.ordinal
    FROM billing.feature_free_trials AS fft
    WHERE fft.user_id = p_user_id
      AND fft.feature = p_feature
      AND fft.status IN ('reserved', 'consumed')
  );

  IF v_ordinal IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'FEATURE_FREE_TRIAL_EXHAUSTED',
      'message', 'free trial occupancy exceeds the account limit'
    );
  END IF;

  IF v_existing.id IS NOT NULL AND v_existing.status = 'released' THEN
    UPDATE billing.feature_free_trials
    SET
      ordinal = v_ordinal,
      status = 'reserved',
      reserved_until = now() + make_interval(secs => v_ttl),
      consumed_at = NULL,
      released_at = NULL,
      updated_at = now()
    WHERE id = v_existing.id
    RETURNING * INTO v_row;
  ELSE
    INSERT INTO billing.feature_free_trials (
      user_id,
      feature,
      reference_id,
      ordinal,
      status,
      reserved_until
    ) VALUES (
      p_user_id,
      p_feature,
      v_reference,
      v_ordinal,
      'reserved',
      now() + make_interval(secs => v_ttl)
    )
    RETURNING * INTO v_row;
  END IF;

  SELECT
    count(*) FILTER (WHERE status = 'consumed'),
    count(*) FILTER (WHERE status = 'reserved')
  INTO v_used, v_reserved
  FROM billing.feature_free_trials
  WHERE user_id = p_user_id AND feature = p_feature AND status IN ('reserved', 'consumed');

  SELECT MIN(g.ordinal)
  INTO v_ordinal
  FROM generate_series(1, 3) AS g(ordinal)
  WHERE g.ordinal NOT IN (
    SELECT fft.ordinal
    FROM billing.feature_free_trials AS fft
    WHERE fft.user_id = p_user_id
      AND fft.feature = p_feature
      AND fft.status IN ('reserved', 'consumed')
  );

  RETURN jsonb_build_object(
    'ok', true,
    'status', 'reserved',
    'fact', to_jsonb(v_row),
    'quota', jsonb_build_object(
      'feature', p_feature,
      'free_trial_limit', 3,
      'free_trials_used', v_used,
      'free_trials_reserved', v_reserved,
      'free_trials_remaining', 3 - v_used - v_reserved,
      'next_trial_ordinal', v_ordinal
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION billing.consume_feature_free_trial(
  p_user_id UUID,
  p_feature TEXT,
  p_reference_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_reference TEXT := btrim(COALESCE(p_reference_id, ''));
  v_row billing.feature_free_trials;
BEGIN
  IF p_user_id IS NULL OR p_feature NOT IN ('voice', 'basic_image') OR v_reference = '' THEN
    RAISE EXCEPTION 'FEATURE_FREE_TRIAL_INVALID_STATE'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(74210022, hashtext(p_user_id::text || ':' || p_feature));
  -- 过期仍停在 reserved 的迟到成功必须先回收，不能静默 consumed。
  PERFORM billing.reclaim_expired_feature_free_trials(p_user_id, p_feature);

  SELECT *
  INTO v_row
  FROM billing.feature_free_trials
  WHERE reference_id = v_reference
  FOR UPDATE;

  IF NOT FOUND OR v_row.user_id <> p_user_id OR v_row.feature <> p_feature THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'FEATURE_FREE_TRIAL_INVALID_STATE',
      'message', 'free trial reservation was not found'
    );
  END IF;

  IF v_row.status = 'consumed' THEN
    RETURN jsonb_build_object('ok', true, 'status', 'already_consumed', 'fact', to_jsonb(v_row));
  END IF;

  IF v_row.status <> 'reserved' THEN
    -- 过期已被回收或失败已释放：迟到成功不得静默改成收费。
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'FEATURE_FREE_TRIAL_INVALID_STATE',
      'message', 'late success cannot consume a released free-trial slot'
    );
  END IF;

  UPDATE billing.feature_free_trials
  SET
    status = 'consumed',
    consumed_at = now(),
    updated_at = now()
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('ok', true, 'status', 'consumed', 'fact', to_jsonb(v_row));
END;
$$;

CREATE OR REPLACE FUNCTION billing.release_feature_free_trial(
  p_user_id UUID,
  p_feature TEXT,
  p_reference_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_reference TEXT := btrim(COALESCE(p_reference_id, ''));
  v_row billing.feature_free_trials;
BEGIN
  IF p_user_id IS NULL OR p_feature NOT IN ('voice', 'basic_image') OR v_reference = '' THEN
    RAISE EXCEPTION 'FEATURE_FREE_TRIAL_INVALID_STATE'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(74210022, hashtext(p_user_id::text || ':' || p_feature));

  SELECT *
  INTO v_row
  FROM billing.feature_free_trials
  WHERE reference_id = v_reference
  FOR UPDATE;

  IF NOT FOUND OR v_row.user_id <> p_user_id OR v_row.feature <> p_feature THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'FEATURE_FREE_TRIAL_INVALID_STATE',
      'message', 'free trial reservation was not found'
    );
  END IF;

  IF v_row.status = 'released' THEN
    RETURN jsonb_build_object('ok', true, 'status', 'already_released', 'fact', to_jsonb(v_row));
  END IF;

  IF v_row.status = 'consumed' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'FEATURE_FREE_TRIAL_INVALID_STATE',
      'message', 'consumed free trials cannot be released'
    );
  END IF;

  UPDATE billing.feature_free_trials
  SET
    status = 'released',
    released_at = now(),
    updated_at = now()
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('ok', true, 'status', 'released', 'fact', to_jsonb(v_row));
END;
$$;

CREATE OR REPLACE FUNCTION miniapp_features.claim_daily_checkin(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_wallet billing.user_wallets;
  v_last_claimed_at TIMESTAMPTZ;
  v_reward INTEGER;
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

  -- 首次签到没有行可锁；用户级事务锁挡住并发双发。
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
        10
      )
    )::integer,
    10
  )
  INTO v_reward;

  IF v_reward <= 0 THEN
    RAISE EXCEPTION 'daily check-in reward must be positive: %', v_reward
      USING ERRCODE = '22023';
  END IF;

  -- T3 才会把基础奖励收敛为 60 并叠加 VIP 60。本轮 vip_reward 固定 0，避免 test 40 被静默改掉。
  SELECT * INTO v_grant
  FROM billing.grant_bonus_credits(
    p_user_id,
    v_reward,
    'checkin_bonus',
    'daily_checkin',
    p_user_id::text,
    jsonb_build_object(
      'claimed_at', v_claimed_at,
      'base_reward_credits', v_reward,
      'vip_reward_credits', 0,
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
    v_reward,
    v_claimed_at
  );

  RETURN jsonb_build_object(
    'wallet', to_jsonb(v_wallet),
    'checkin', jsonb_build_object(
      'claimed_at', v_claimed_at,
      'next_claim_at', v_claimed_at + interval '24 hours',
      'reward_credits', v_reward,
      'base_reward_credits', v_reward,
      'vip_reward_credits', 0,
      'vip_active', v_vip_active,
      'wallet_ledger_id', v_ledger_id
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION miniapp_features.insert_vip_expiry_reminder(
  p_user_id UUID,
  p_reminder_window TEXT,
  p_observed_valid_until TIMESTAMPTZ,
  p_title TEXT,
  p_body TEXT,
  p_action_path TEXT DEFAULT '/vip'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_membership billing.vip_memberships;
  v_today DATE;
  v_expiry_local DATE;
  v_key TEXT;
  v_existing UUID;
  v_row miniapp_features.notifications;
  v_title TEXT := btrim(COALESCE(p_title, ''));
  v_body TEXT := btrim(COALESCE(p_body, ''));
  v_path TEXT := COALESCE(p_action_path, '/vip');
BEGIN
  IF p_user_id IS NULL
     OR p_reminder_window NOT IN ('expiring_soon', 'expires_today')
     OR p_observed_valid_until IS NULL THEN
    RAISE EXCEPTION 'invalid vip reminder input'
      USING ERRCODE = '22023';
  END IF;
  IF char_length(v_title) NOT BETWEEN 1 AND 120 OR char_length(v_body) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'reminder title/body is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF v_path NOT LIKE '/%' OR char_length(v_path) > 200 THEN
    RAISE EXCEPTION 'reminder action_path is invalid'
      USING ERRCODE = '22023';
  END IF;

  v_today := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_expiry_local := (p_observed_valid_until AT TIME ZONE 'Asia/Shanghai')::date;

  IF p_reminder_window = 'expiring_soon' AND v_expiry_local <> (v_today + 3) THEN
    RETURN jsonb_build_object('ok', true, 'status', 'skipped_window');
  END IF;
  IF p_reminder_window = 'expires_today' AND v_expiry_local <> v_today THEN
    RETURN jsonb_build_object('ok', true, 'status', 'skipped_window');
  END IF;

  SELECT *
  INTO v_membership
  FROM billing.vip_memberships
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'status', 'skipped_missing');
  END IF;

  IF v_membership.valid_until IS DISTINCT FROM p_observed_valid_until THEN
    RETURN jsonb_build_object('ok', true, 'status', 'skipped_stale');
  END IF;

  v_key := format(
    'vip_expiry:%s:%s:%s',
    p_user_id::text,
    to_char(p_observed_valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    p_reminder_window
  );

  SELECT id
  INTO v_existing
  FROM miniapp_features.notifications
  WHERE business_key = v_key;

  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'status', 'already_inserted', 'notification_id', v_existing);
  END IF;

  INSERT INTO miniapp_features.notifications (
    scope,
    category,
    title,
    body,
    user_id,
    sort_order,
    is_published,
    published_at,
    kind,
    business_key,
    action_path,
    metadata
  ) VALUES (
    'official',
    'system',
    v_title,
    v_body,
    p_user_id,
    0,
    true,
    now(),
    'vip_expiry',
    v_key,
    v_path,
    jsonb_build_object(
      'reminder_window', p_reminder_window,
      'observed_valid_until', to_char(p_observed_valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    )
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true,
    'status', 'inserted',
    'notification_id', v_row.id,
    'business_key', v_key
  );
EXCEPTION
  WHEN unique_violation THEN
    SELECT id INTO v_existing
    FROM miniapp_features.notifications
    WHERE business_key = v_key;
    RETURN jsonb_build_object('ok', true, 'status', 'already_inserted', 'notification_id', v_existing);
END;
$$;

REVOKE ALL ON FUNCTION billing.reclaim_expired_feature_free_trials(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.reclaim_expired_feature_free_trials(UUID, TEXT)
  TO postgres, service_role;

REVOKE ALL ON FUNCTION billing.reserve_feature_free_trial(UUID, TEXT, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.reserve_feature_free_trial(UUID, TEXT, TEXT, INTEGER)
  TO postgres, service_role;

REVOKE ALL ON FUNCTION billing.consume_feature_free_trial(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.consume_feature_free_trial(UUID, TEXT, TEXT)
  TO postgres, service_role;

REVOKE ALL ON FUNCTION billing.release_feature_free_trial(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.release_feature_free_trial(UUID, TEXT, TEXT)
  TO postgres, service_role;

REVOKE ALL ON FUNCTION miniapp_features.insert_vip_expiry_reminder(UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION miniapp_features.insert_vip_expiry_reminder(UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT)
  TO postgres, service_role;

-- 签到保持历史 EXECUTE，以免旧调用面在发布窗口变化。
GRANT EXECUTE ON FUNCTION miniapp_features.claim_daily_checkin(UUID)
  TO postgres, service_role;

COMMENT ON FUNCTION billing.reserve_feature_free_trial(UUID, TEXT, TEXT, INTEGER) IS
  '为 voice/basic_image 预留 1..3 号免费名额。released 不占 used。仅 service_role。';
COMMENT ON FUNCTION miniapp_features.insert_vip_expiry_reminder(UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT) IS
  '按 Asia/Shanghai 业务日期插入官方 VIP 到期提醒。business_key 去重。不发送推送。';
COMMENT ON FUNCTION miniapp_features.claim_daily_checkin(UUID) IS
  '每日签到。用户级锁防首次并发。可读 VIP 但不改变当前 runtime_config 奖励。';

DO $$
DECLARE
  v_cfg TEXT[];
BEGIN
  IF to_regprocedure('billing.reserve_feature_free_trial(uuid,text,text,integer)') IS NULL
     OR to_regprocedure('billing.consume_feature_free_trial(uuid,text,text)') IS NULL
     OR to_regprocedure('billing.release_feature_free_trial(uuid,text,text)') IS NULL
     OR to_regprocedure('miniapp_features.insert_vip_expiry_reminder(uuid,text,timestamptz,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'postflight: free-trial or reminder functions missing';
  END IF;

  SELECT proconfig INTO v_cfg
  FROM pg_proc
  WHERE oid = 'miniapp_features.claim_daily_checkin(uuid)'::regprocedure;
  IF v_cfg IS NULL OR NOT ('search_path=pg_catalog' = ANY (v_cfg)) THEN
    RAISE EXCEPTION 'postflight: claim_daily_checkin search_path is not pg_catalog';
  END IF;

  IF has_function_privilege('anon', 'billing.reserve_feature_free_trial(uuid,text,text,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'miniapp_features.insert_vip_expiry_reminder(uuid,text,timestamptz,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postflight: new RPCs must not be executable by anon/authenticated';
  END IF;

  IF NOT has_function_privilege('anon', 'miniapp_features.claim_daily_checkin(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'miniapp_features.claim_daily_checkin(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postflight: claim_daily_checkin must keep historical anon/authenticated EXECUTE';
  END IF;

  IF position('pg_cron' IN pg_get_functiondef('miniapp_features.insert_vip_expiry_reminder(uuid,text,timestamptz,text,text,text)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'postflight: reminder RPC must not reference pg_cron';
  END IF;
END;
$$;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- 回滚：DROP 新函数；claim_daily_checkin 需 forward-fix 回旧体，不能丢已发奖励。
