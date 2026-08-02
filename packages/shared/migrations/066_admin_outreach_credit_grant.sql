-- 运营平台「回访星尘赠送」：客服按用户 ID 定向发放星尘，并把到账通知投递到
-- MiniApp 消息中心的「官方」列表。
--
-- 064 建表时把「官方」写死成全员广播（scope='official' 必须 user_id IS NULL），
-- 而本次产品要求这条到账通知落在「官方」而不是「消息」，因此放宽约束：官方消息
-- 既可以是广播（user_id 为空），也可以定向到单个用户；「消息」仍然必须有归属人。
-- 放宽后读取侧必须同步收紧，否则一个用户会看到发给别人的官方消息，
-- 相关改动在 packages/backend/src/routes/notifications.ts。

BEGIN;

-- 原约束是建表时的匿名 CHECK，名字由 Postgres 生成，只能按定义反查后再删。
DO $$
DECLARE
  v_name TEXT;
BEGIN
  SELECT constraint_def.conname INTO v_name
  FROM pg_catalog.pg_constraint AS constraint_def
  WHERE constraint_def.conrelid = 'miniapp.notifications'::regclass
    AND constraint_def.contype = 'c'
    AND pg_catalog.pg_get_constraintdef(constraint_def.oid) ILIKE '%official%user_id IS NULL%';
  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE miniapp.notifications DROP CONSTRAINT %I', v_name);
  END IF;
END $$;

ALTER TABLE miniapp.notifications
  DROP CONSTRAINT IF EXISTS notifications_scope_target_check;
ALTER TABLE miniapp.notifications
  ADD CONSTRAINT notifications_scope_target_check CHECK (
    scope = 'official' OR (scope = 'personal' AND user_id IS NOT NULL)
  );

COMMENT ON COLUMN miniapp.notifications.user_id IS
  '归属用户。「消息」必须有归属人；「官方」为空表示全员广播，不为空表示定向投递给该用户。';

CREATE INDEX IF NOT EXISTS idx_notifications_official_targeted
  ON miniapp.notifications (user_id, published_at DESC)
  WHERE scope = 'official' AND user_id IS NOT NULL AND is_published AND deleted_at IS NULL;

-- 一次点击一个 request id：网络重试不会重复发放，运营真要再发一次会带新的 id。
-- 唯一索引兜住并发，函数里的预检只是为了把重试变成正常返回而不是报错。
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_ledger_outreach_grant_request
  ON miniapp.wallet_ledger (reference_id)
  WHERE reference_type = 'outreach_grant';

-- 公告管理页只该看到广播公告，定向发放产生的官方消息不属于它的管辖范围。
CREATE OR REPLACE FUNCTION admin.list_announcements()
RETURNS SETOF miniapp.notifications
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'admin is not permitted to access current environment'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT notification.*
  FROM miniapp.notifications AS notification
  WHERE notification.scope = 'official'
    AND notification.user_id IS NULL
    AND notification.deleted_at IS NULL
  ORDER BY notification.sort_order, notification.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION admin.update_announcement(
  p_id UUID,
  p_category TEXT,
  p_title TEXT,
  p_body TEXT,
  p_sort_order INTEGER
) RETURNS miniapp.notifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_before miniapp.notifications%ROWTYPE;
  v_after miniapp.notifications%ROWTYPE;
BEGIN
  SELECT actor.* INTO v_actor FROM admin.admin_users AS actor WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  SELECT notification.* INTO v_before
  FROM miniapp.notifications AS notification
  WHERE notification.id = p_id AND notification.scope = 'official'
    AND notification.user_id IS NULL
    AND notification.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'announcement not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE miniapp.notifications
  SET category = p_category, title = trim(p_title), body = trim(p_body),
      sort_order = p_sort_order, updated_at = now()
  WHERE id = p_id
  RETURNING * INTO v_after;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name, table_name,
    record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    'announcement.update', 'miniapp', 'notifications', p_id::TEXT,
    to_jsonb(v_before), to_jsonb(v_after)
  );
  RETURN v_after;
END;
$$;

CREATE OR REPLACE FUNCTION admin.set_announcement_published(
  p_id UUID,
  p_is_published BOOLEAN
) RETURNS miniapp.notifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_before miniapp.notifications%ROWTYPE;
  v_after miniapp.notifications%ROWTYPE;
BEGIN
  SELECT actor.* INTO v_actor FROM admin.admin_users AS actor WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  SELECT notification.* INTO v_before
  FROM miniapp.notifications AS notification
  WHERE notification.id = p_id AND notification.scope = 'official'
    AND notification.user_id IS NULL
    AND notification.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'announcement not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE miniapp.notifications
  SET is_published = COALESCE(p_is_published, false),
      published_at = CASE
        WHEN COALESCE(p_is_published, false) THEN COALESCE(published_at, now())
        ELSE NULL
      END,
      updated_at = now()
  WHERE id = p_id
  RETURNING * INTO v_after;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name, table_name,
    record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    CASE WHEN v_after.is_published THEN 'announcement.publish' ELSE 'announcement.unpublish' END,
    'miniapp', 'notifications', p_id::TEXT, to_jsonb(v_before), to_jsonb(v_after)
  );
  RETURN v_after;
END;
$$;

CREATE OR REPLACE FUNCTION admin.delete_announcement(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_before miniapp.notifications%ROWTYPE;
BEGIN
  SELECT actor.* INTO v_actor FROM admin.admin_users AS actor WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  UPDATE miniapp.notifications
  SET deleted_at = now(), is_published = false, updated_at = now()
  WHERE id = p_id AND scope = 'official' AND user_id IS NULL AND deleted_at IS NULL
  RETURNING * INTO v_before;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'announcement not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name, table_name,
    record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    'announcement.delete', 'miniapp', 'notifications', p_id::TEXT,
    to_jsonb(v_before), NULL
  );
END;
$$;

-- 赠送前的用户回显。客服手上可能是 CS 平台导出的用户 UUID，也可能只有 Telegram ID，
-- 两种都接受；查不到时返回 found=false 交给前端提示，不抛异常。
CREATE OR REPLACE FUNCTION admin.lookup_user_for_credit_grant(p_identifier TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_identifier TEXT := trim(COALESCE(p_identifier, ''));
  v_user miniapp.users%ROWTYPE;
  v_user_id UUID;
BEGIN
  SELECT actor.* INTO v_actor FROM admin.admin_users AS actor WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  IF v_identifier = '' THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  BEGIN
    v_user_id := v_identifier::UUID;
  EXCEPTION WHEN invalid_text_representation THEN
    v_user_id := NULL;
  END;

  IF v_user_id IS NOT NULL THEN
    SELECT app_user.* INTO v_user
    FROM miniapp.users AS app_user
    WHERE app_user.id = v_user_id;
  ELSE
    SELECT app_user.* INTO v_user
    FROM miniapp.users AS app_user
    WHERE app_user.tg_id = v_identifier;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'found', true,
      'user_id', v_user.id,
      'tg_id', v_user.tg_id,
      'display_name', COALESCE(settings.display_name, settings.tg_first_name),
      'tg_username', settings.tg_username,
      'main_credits', COALESCE(wallet.main_credits, 0),
      'bonus_credits', COALESCE(wallet.bonus_credits, 0),
      'total_credits', COALESCE(wallet.total_credits, 0),
      'created_at', v_user.created_at,
      -- 客服在发放前能看到这个人最近拿过什么，避免凭记忆判断是否已发过。
      'recent_grants', COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object('amount', recent.amount, 'created_at', recent.created_at)
            ORDER BY recent.created_at DESC
          )
          FROM (
            SELECT ledger.amount, ledger.created_at
            FROM miniapp.wallet_ledger AS ledger
            WHERE ledger.user_id = v_user.id
              AND ledger.reference_type = 'outreach_grant'
            ORDER BY ledger.created_at DESC
            LIMIT 5
          ) AS recent
        ),
        '[]'::jsonb
      )
    )
    FROM (SELECT 1) AS anchor
    LEFT JOIN miniapp.miniapp_user_settings AS settings ON settings.user_id = v_user.id
    LEFT JOIN miniapp.user_wallets AS wallet ON wallet.user_id = v_user.id
  );
END;
$$;

-- 发放与到账通知在同一个事务里：要么星尘和消息一起成立，要么都不成立，
-- 不会出现「星尘到账但用户看不到通知」需要人工补推的中间态。
DROP FUNCTION IF EXISTS admin.grant_user_credits(UUID, INTEGER, TEXT, TEXT, UUID);
CREATE OR REPLACE FUNCTION admin.grant_user_credits(
  p_user_id UUID,
  p_amount INTEGER,
  p_title TEXT,
  p_body TEXT,
  p_request_id UUID,
  p_allow_duplicate BOOLEAN DEFAULT false
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_wallet miniapp.user_wallets%ROWTYPE;
  v_existing miniapp.wallet_ledger%ROWTYPE;
  v_recent miniapp.wallet_ledger%ROWTYPE;
  v_notification miniapp.notifications%ROWTYPE;
  v_title TEXT := trim(COALESCE(p_title, ''));
  v_body TEXT := trim(COALESCE(p_body, ''));
BEGIN
  SELECT actor.* INTO v_actor FROM admin.admin_users AS actor WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'grant request id is required' USING ERRCODE = '22023';
  END IF;
  -- 上限只是防手滑的硬闸，运营侧的额度规则本次不做。
  IF p_amount IS NULL OR p_amount < 1 OR p_amount > 100000 THEN
    RAISE EXCEPTION 'grant amount must be between 1 and 100000' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_title) < 1 OR char_length(v_title) > 120 THEN
    RAISE EXCEPTION 'notification title must be 1-120 chars' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_body) < 1 OR char_length(v_body) > 4000 THEN
    RAISE EXCEPTION 'notification body must be 1-4000 chars' USING ERRCODE = '22023';
  END IF;

  SELECT ledger.* INTO v_existing
  FROM miniapp.wallet_ledger AS ledger
  WHERE ledger.reference_type = 'outreach_grant'
    AND ledger.reference_id = p_request_id::TEXT;
  IF FOUND THEN
    SELECT wallet.* INTO v_wallet
    FROM miniapp.user_wallets AS wallet
    WHERE wallet.user_id = v_existing.user_id;
    RETURN jsonb_build_object(
      'granted', false,
      'blocked', false,
      'user_id', v_existing.user_id,
      'amount', v_existing.amount,
      'main_credits', v_wallet.main_credits,
      'bonus_credits', v_wallet.bonus_credits,
      'total_credits', v_wallet.total_credits,
      'notification_id', v_existing.metadata ->> 'notification_id',
      'granted_at', v_existing.created_at
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM miniapp.users AS app_user WHERE app_user.id = p_user_id) THEN
    RAISE EXCEPTION 'user not found' USING ERRCODE = 'P0002';
  END IF;

  -- request id 只能挡住「同一次操作」的重试。换台机器、换个浏览器重来会带新的 id，
  -- 所以这里再按「同一人同一金额」加一道短时窗软拦截：不报错，回一个待确认状态，
  -- 由客服显式放行。PRD 允许短时间内重复赠送，因此只能软拦不能硬禁。
  IF NOT COALESCE(p_allow_duplicate, false) THEN
    SELECT ledger.* INTO v_recent
    FROM miniapp.wallet_ledger AS ledger
    WHERE ledger.user_id = p_user_id
      AND ledger.reference_type = 'outreach_grant'
      AND ledger.amount = p_amount
      AND ledger.created_at > now() - interval '10 minutes'
    ORDER BY ledger.created_at DESC
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'granted', false,
        'blocked', true,
        'reason', 'duplicate_window',
        'user_id', p_user_id,
        'amount', p_amount,
        'last_amount', v_recent.amount,
        'last_granted_at', v_recent.created_at
      );
    END IF;
  END IF;

  INSERT INTO miniapp.user_wallets (user_id) VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT wallet.* INTO v_wallet
  FROM miniapp.user_wallets AS wallet
  WHERE wallet.user_id = p_user_id
  FOR UPDATE;

  -- 与新用户赠送、签到、许愿奖励一致，运营赠送只加 bonus_credits。
  UPDATE miniapp.user_wallets
  SET bonus_credits = bonus_credits + p_amount, updated_at = now()
  WHERE user_id = p_user_id
  RETURNING * INTO v_wallet;

  INSERT INTO miniapp.notifications (
    scope, category, title, body, user_id, is_published, published_at, created_by
  ) VALUES (
    'official', 'activity', v_title, v_body, p_user_id, true, now(), v_actor.user_id
  ) RETURNING * INTO v_notification;

  INSERT INTO miniapp.wallet_ledger (
    user_id, entry_type, amount, main_delta, bonus_delta,
    balance_main, balance_bonus, reference_type, reference_id, metadata
  ) VALUES (
    p_user_id, 'adjustment', p_amount, 0, p_amount,
    v_wallet.main_credits, v_wallet.bonus_credits, 'outreach_grant', p_request_id::TEXT,
    jsonb_build_object(
      'reason', 'outreach_grant',
      'notification_id', v_notification.id,
      'actor_user_id', v_actor.user_id,
      'actor_email', v_actor.email
    )
  );

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name, table_name,
    record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    'wallet.outreach_grant', 'miniapp', 'user_wallets', p_user_id::TEXT,
    NULL,
    jsonb_build_object(
      'amount', p_amount,
      'request_id', p_request_id,
      'notification_id', v_notification.id,
      'balance_bonus', v_wallet.bonus_credits
    )
  );

  RETURN jsonb_build_object(
    'granted', true,
    'blocked', false,
    'user_id', p_user_id,
    'amount', p_amount,
    'main_credits', v_wallet.main_credits,
    'bonus_credits', v_wallet.bonus_credits,
    'total_credits', v_wallet.total_credits,
    'notification_id', v_notification.id,
    'granted_at', v_notification.published_at
  );
END;
$$;

REVOKE ALL ON FUNCTION admin.lookup_user_for_credit_grant(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.grant_user_credits(UUID, INTEGER, TEXT, TEXT, UUID, BOOLEAN)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION admin.lookup_user_for_credit_grant(TEXT)
  TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.grant_user_credits(UUID, INTEGER, TEXT, TEXT, UUID, BOOLEAN)
  TO authenticated, service_role, postgres;

COMMIT;

NOTIFY pgrst, 'reload schema';
