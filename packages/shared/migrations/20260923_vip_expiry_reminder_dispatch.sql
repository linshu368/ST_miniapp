-- 20260923_vip_expiry_reminder_dispatch.sql
-- domain: miniapp_features, reads billing.vip_memberships
--
-- T6 forward-fix。不修改已应用的 20260921_* / 20260922_* / 20260923_vip_strategy_config.sql。
-- 不新建表。通知列、business_key 唯一索引和 insert_vip_expiry_reminder 六参签名都已存在。
--
-- 对象：
--   miniapp_features.vip_expiry_reminder_business_key
--   miniapp_features.vip_expiry_reminder_window
--   miniapp_features.insert_due_vip_expiry_reminder(uuid)
--   miniapp_features.list_vip_expiry_reminder_candidates(integer, uuid)
--   替换后的 miniapp_features.insert_vip_expiry_reminder(uuid, text, timestamptz, text, text, text)
--
-- 归属：提醒行是消息中心事实，函数放在 miniapp_features。会员截止时间的权威投影仍是
-- billing.vip_memberships。权威写入方是 service_role 调用的这两个新 RPC；客户端不能选 user_id。
-- 已发送的通知不因续费或配置变化被更新或删除。运行时消费者是 Backend 到期脚本和消息 API。
--
-- 跨 schema：函数读取 billing.vip_memberships，写入 miniapp_features.notifications。
-- 续费事务也对同一会员行 FOR UPDATE。提醒先锁则写入锁定时的周期；
-- 续费先锁则提醒只能看到提交后的新周期，旧周期未发送的提醒不再插入。
--
-- 为什么 SECURITY DEFINER：会员表和通知表都开了 RLS 且没有 anon/authenticated policy。
-- 函数必须在表主的权限下加锁和写入，不能依赖调用方绕过 RLS。search_path 固定为 pg_catalog，
-- 对象全部带 schema。PUBLIC / anon / authenticated 不可执行。
--
-- 文案与 packages/shared/src/api/notifications.ts 的标题、vipExpiryReminderBody 保持一致。
-- 提前天数、时区和正文不是运营配置。
--
-- 锁：本文件只替换函数，不改表、不重写业务行。lock_timeout 5s。
-- 恢复：不要 down migration。若要停写，把 vip_reminders_enabled 保持 false，并停掉 Cron。
-- 已插入的通知保留。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF to_regclass('billing.vip_memberships') IS NULL
     OR to_regclass('miniapp_features.notifications') IS NULL THEN
    RAISE EXCEPTION '20260923_vip_expiry_reminder_dispatch: required tables missing';
  END IF;
  IF to_regprocedure('miniapp_features.insert_vip_expiry_reminder(uuid,text,timestamptz,text,text,text)') IS NULL THEN
    RAISE EXCEPTION '20260923_vip_expiry_reminder_dispatch: base reminder RPC missing';
  END IF;
  IF to_regprocedure('miniapp_features.insert_due_vip_expiry_reminder(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '20260923_vip_expiry_reminder_dispatch: already applied';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'miniapp_features'
      AND indexname = 'uq_notifications_business_key'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'billing'
      AND indexname = 'idx_vip_memberships_valid_until'
  ) THEN
    RAISE EXCEPTION '20260923_vip_expiry_reminder_dispatch: reminder indexes missing';
  END IF;
END;
$$;

CREATE FUNCTION miniapp_features.vip_expiry_reminder_business_key(
  p_user_id UUID,
  p_valid_until TIMESTAMPTZ,
  p_reminder_window TEXT
) RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT format(
    'vip_expiry:%s:%s:%s',
    p_user_id::text,
    to_char(p_valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    p_reminder_window
  );
$$;

-- 只比较 Asia/Shanghai 的日历日。会话 TimeZone 不参与。上海无夏令时，日期运算走 date 类型。
CREATE FUNCTION miniapp_features.vip_expiry_reminder_window(
  p_valid_until TIMESTAMPTZ,
  p_now TIMESTAMPTZ
) RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_valid_until IS NULL OR p_now IS NULL THEN NULL
    WHEN (p_valid_until AT TIME ZONE 'Asia/Shanghai')::date
      = (((p_now AT TIME ZONE 'Asia/Shanghai')::date) + 3) THEN 'expiring_soon'
    WHEN (p_valid_until AT TIME ZONE 'Asia/Shanghai')::date
      = (p_now AT TIME ZONE 'Asia/Shanghai')::date THEN 'expires_today'
    ELSE NULL
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

  -- 窗口和周期都在行锁内核对。续费若已提交，这里看到的是新 valid_until。
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

  IF miniapp_features.vip_expiry_reminder_window(v_membership.valid_until, pg_catalog.now())
     IS DISTINCT FROM p_reminder_window THEN
    RETURN jsonb_build_object('ok', true, 'status', 'skipped_window');
  END IF;

  v_key := miniapp_features.vip_expiry_reminder_business_key(
    p_user_id,
    v_membership.valid_until,
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
    pg_catalog.now(),
    'vip_expiry',
    v_key,
    v_path,
    jsonb_build_object(
      'reminder_window', p_reminder_window,
      'observed_valid_until', to_char(v_membership.valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
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

-- 调用方只提供 user_id。截止时间、窗口和幂等键都从锁定行读取，避免经过客户端再传时间戳。
CREATE FUNCTION miniapp_features.insert_due_vip_expiry_reminder(
  p_user_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_membership billing.vip_memberships;
  v_window TEXT;
  v_date TEXT;
  v_title TEXT;
  v_body TEXT;
BEGIN
  PERFORM set_config('statement_timeout', '5s', true);

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid vip reminder input'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_membership
  FROM billing.vip_memberships
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'status', 'skipped_missing');
  END IF;

  v_window := miniapp_features.vip_expiry_reminder_window(v_membership.valid_until, pg_catalog.now());
  IF v_window IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'status', 'skipped_window');
  END IF;

  v_date := to_char(v_membership.valid_until AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD');
  IF v_window = 'expiring_soon' THEN
    v_title := 'VIP 即将到期';
    v_body := format('您的 VIP 将于 %s（北京时间）到期。', v_date);
  ELSE
    v_title := 'VIP 今日到期';
    v_body := format('您的 VIP 于 %s（北京时间）到期。', v_date);
  END IF;

  RETURN miniapp_features.insert_vip_expiry_reminder(
    p_user_id,
    v_window,
    v_membership.valid_until,
    v_title,
    v_body,
    '/vip'
  );
END;
$$;

-- 每个分支都按 valid_until 索引范围限制，再用 LIMIT 截断。不扫整张会员表。
CREATE FUNCTION miniapp_features.list_vip_expiry_reminder_candidates(
  p_limit INTEGER,
  p_after_user_id UUID DEFAULT NULL
) RETURNS SETOF UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_local_midnight TIMESTAMP;
  v_today_start TIMESTAMPTZ;
  v_tomorrow_start TIMESTAMPTZ;
  v_soon_start TIMESTAMPTZ;
  v_soon_end TIMESTAMPTZ;
BEGIN
  PERFORM set_config('statement_timeout', '5s', true);

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'vip reminder batch limit must be 1..100'
      USING ERRCODE = '22023';
  END IF;

  v_local_midnight := date_trunc('day', v_now AT TIME ZONE 'Asia/Shanghai');
  v_today_start := v_local_midnight AT TIME ZONE 'Asia/Shanghai';
  v_tomorrow_start := (v_local_midnight + interval '1 day') AT TIME ZONE 'Asia/Shanghai';
  v_soon_start := (v_local_midnight + interval '3 day') AT TIME ZONE 'Asia/Shanghai';
  v_soon_end := (v_local_midnight + interval '4 day') AT TIME ZONE 'Asia/Shanghai';

  RETURN QUERY
  SELECT picked.user_id
  FROM (
    (
      SELECT m.user_id
      FROM billing.vip_memberships m
      WHERE m.valid_until >= v_today_start
        AND m.valid_until < v_tomorrow_start
        AND (p_after_user_id IS NULL OR m.user_id > p_after_user_id)
        AND NOT EXISTS (
          SELECT 1
          FROM miniapp_features.notifications n
          WHERE n.business_key = miniapp_features.vip_expiry_reminder_business_key(
            m.user_id, m.valid_until, 'expires_today'
          )
        )
      ORDER BY m.user_id
      LIMIT p_limit
    )
    UNION ALL
    (
      SELECT m.user_id
      FROM billing.vip_memberships m
      WHERE m.valid_until >= v_soon_start
        AND m.valid_until < v_soon_end
        AND (p_after_user_id IS NULL OR m.user_id > p_after_user_id)
        AND NOT EXISTS (
          SELECT 1
          FROM miniapp_features.notifications n
          WHERE n.business_key = miniapp_features.vip_expiry_reminder_business_key(
            m.user_id, m.valid_until, 'expiring_soon'
          )
        )
      ORDER BY m.user_id
      LIMIT p_limit
    )
  ) picked
  ORDER BY picked.user_id
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION miniapp_features.vip_expiry_reminder_business_key(UUID, TIMESTAMPTZ, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION miniapp_features.vip_expiry_reminder_business_key(UUID, TIMESTAMPTZ, TEXT)
  TO postgres, service_role;

REVOKE ALL ON FUNCTION miniapp_features.vip_expiry_reminder_window(TIMESTAMPTZ, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION miniapp_features.vip_expiry_reminder_window(TIMESTAMPTZ, TIMESTAMPTZ)
  TO postgres, service_role;

REVOKE ALL ON FUNCTION miniapp_features.insert_vip_expiry_reminder(UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION miniapp_features.insert_vip_expiry_reminder(UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT)
  TO postgres, service_role;

REVOKE ALL ON FUNCTION miniapp_features.insert_due_vip_expiry_reminder(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION miniapp_features.insert_due_vip_expiry_reminder(UUID)
  TO postgres, service_role;

REVOKE ALL ON FUNCTION miniapp_features.list_vip_expiry_reminder_candidates(INTEGER, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION miniapp_features.list_vip_expiry_reminder_candidates(INTEGER, UUID)
  TO postgres, service_role;

COMMENT ON FUNCTION miniapp_features.vip_expiry_reminder_window(TIMESTAMPTZ, TIMESTAMPTZ) IS
  '上海日历日：今天+3 天为 expiring_soon，当天为 expires_today，其余不发送。';
COMMENT ON FUNCTION miniapp_features.insert_due_vip_expiry_reminder(UUID) IS
  '锁定当前会员行后插入一条官方定向到期提醒。同周期同类型只插入一次。不删除历史行。';
COMMENT ON FUNCTION miniapp_features.list_vip_expiry_reminder_candidates(INTEGER, UUID) IS
  '按上海日期窗口返回尚未发送的会员，单批 1..100。不向客户端暴露。';

DO $$
DECLARE
  v_cfg TEXT[];
  v_def TEXT;
BEGIN
  IF to_regprocedure('miniapp_features.insert_due_vip_expiry_reminder(uuid)') IS NULL
     OR to_regprocedure('miniapp_features.list_vip_expiry_reminder_candidates(integer,uuid)') IS NULL
     OR to_regprocedure('miniapp_features.vip_expiry_reminder_window(timestamptz,timestamptz)') IS NULL
     OR to_regprocedure('miniapp_features.insert_vip_expiry_reminder(uuid,text,timestamptz,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'postflight: reminder functions missing';
  END IF;

  SELECT proconfig INTO v_cfg
  FROM pg_proc
  WHERE oid = 'miniapp_features.insert_due_vip_expiry_reminder(uuid)'::regprocedure;
  IF v_cfg IS NULL OR NOT ('search_path=pg_catalog' = ANY (v_cfg)) THEN
    RAISE EXCEPTION 'postflight: insert_due search_path is not pg_catalog';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'miniapp_features.insert_due_vip_expiry_reminder(uuid)'::regprocedure
      AND prosecdef
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'miniapp_features.list_vip_expiry_reminder_candidates(integer,uuid)'::regprocedure
      AND prosecdef
  ) THEN
    RAISE EXCEPTION 'postflight: reminder dispatch functions must be security definer';
  END IF;

  IF has_function_privilege('anon', 'miniapp_features.insert_due_vip_expiry_reminder(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'miniapp_features.insert_due_vip_expiry_reminder(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'miniapp_features.list_vip_expiry_reminder_candidates(integer,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'miniapp_features.list_vip_expiry_reminder_candidates(integer,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'miniapp_features.vip_expiry_reminder_window(timestamptz,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'miniapp_features.vip_expiry_reminder_business_key(uuid,timestamptz,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'miniapp_features.insert_vip_expiry_reminder(uuid,text,timestamptz,text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'miniapp_features.insert_vip_expiry_reminder(uuid,text,timestamptz,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postflight: reminder RPCs must not be executable by anon/authenticated';
  END IF;

  IF NOT has_function_privilege('service_role', 'miniapp_features.insert_due_vip_expiry_reminder(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'miniapp_features.list_vip_expiry_reminder_candidates(integer,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'miniapp_features.insert_vip_expiry_reminder(uuid,text,timestamptz,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postflight: service_role must execute reminder dispatch';
  END IF;

  v_def := pg_get_functiondef('miniapp_features.insert_due_vip_expiry_reminder(uuid)'::regprocedure);
  IF position('FOR UPDATE' IN v_def) = 0
     OR position('Asia/Shanghai' IN v_def) = 0
     OR position('pg_cron' IN v_def) > 0
     OR position('DELETE FROM miniapp_features.notifications' IN v_def) > 0
     OR position('UPDATE miniapp_features.notifications' IN v_def) > 0 THEN
    RAISE EXCEPTION 'postflight: insert_due lock or mutation shape is wrong';
  END IF;

  IF position('pg_cron' IN pg_get_functiondef('miniapp_features.list_vip_expiry_reminder_candidates(integer,uuid)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'postflight: candidate list must not reference pg_cron';
  END IF;
END;
$$;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- 回滚：不要删除已发送通知。停写靠 vip_reminders_enabled=false 和移除 Cron。
-- 若必须撤掉新入口，用后续 forward-fix DROP 新函数，并恢复旧 insert 函数体；不要改本文件。
