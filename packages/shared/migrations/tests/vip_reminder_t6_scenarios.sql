-- Local-only T6 reminder window, idempotency, renewal and grant checks.
-- Never apply this file to test or production.

CREATE SCHEMA IF NOT EXISTS vip_t6_test;

CREATE OR REPLACE FUNCTION vip_t6_test.assert(p_ok BOOLEAN, p_msg TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT COALESCE(p_ok, false) THEN
    RAISE EXCEPTION 't6 assertion failed: %', p_msg;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION vip_t6_test.run()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  u_soon UUID := '00000000-0000-4000-8000-000000000621';
  u_other UUID := '00000000-0000-4000-8000-000000000622';
  u_today_a UUID := '00000000-0000-4000-8000-000000000631';
  u_today_b UUID := '00000000-0000-4000-8000-000000000632';
  u_miss UUID := '00000000-0000-4000-8000-000000000633';
  v_soon TIMESTAMPTZ;
  v_today TIMESTAMPTZ;
  v_plus2 TIMESTAMPTZ;
  v_plus4 TIMESTAMPTZ;
  v_yesterday TIMESTAMPTZ;
  v_far TIMESTAMPTZ;
  v_json JSONB;
  v_count INT;
  v_title TEXT;
  v_body TEXT;
  v_path TEXT;
  v_kind TEXT;
  v_scope TEXT;
  v_key TEXT;
  v_meta JSONB;
  v_old_body TEXT;
  v_old_key TEXT;
  v_old_meta JSONB;
  v_date TEXT;
  v_window TEXT;
  v_utc TEXT;
  v_ny TEXT;
  v_sh TEXT;
  v_id UUID;
BEGIN
  v_soon := ((now() AT TIME ZONE 'Asia/Shanghai')::date + 3 + time '15:00') AT TIME ZONE 'Asia/Shanghai';
  v_today := ((now() AT TIME ZONE 'Asia/Shanghai')::date + time '15:00') AT TIME ZONE 'Asia/Shanghai';
  v_plus2 := ((now() AT TIME ZONE 'Asia/Shanghai')::date + 2 + time '15:00') AT TIME ZONE 'Asia/Shanghai';
  v_plus4 := ((now() AT TIME ZONE 'Asia/Shanghai')::date + 4 + time '15:00') AT TIME ZONE 'Asia/Shanghai';
  v_yesterday := ((now() AT TIME ZONE 'Asia/Shanghai')::date - 1 + time '15:00') AT TIME ZONE 'Asia/Shanghai';
  v_far := now() + interval '40 days';

  -- Fixed instants. These must not follow the session TimeZone.
  PERFORM set_config('TimeZone', 'UTC', true);
  v_utc := miniapp_features.vip_expiry_reminder_window(
    timestamptz '2026-09-23 16:30:00+00',
    timestamptz '2026-09-23 15:30:00+00'
  );
  PERFORM set_config('TimeZone', 'America/New_York', true);
  v_ny := miniapp_features.vip_expiry_reminder_window(
    timestamptz '2026-09-23 16:30:00+00',
    timestamptz '2026-09-23 15:30:00+00'
  );
  PERFORM set_config('TimeZone', 'Asia/Shanghai', true);
  v_sh := miniapp_features.vip_expiry_reminder_window(
    timestamptz '2026-09-23 16:30:00+00',
    timestamptz '2026-09-23 15:30:00+00'
  );
  PERFORM vip_t6_test.assert(v_utc IS NULL AND v_ny IS NULL AND v_sh IS NULL, 'utc/shanghai boundary is not expires_today');
  PERFORM vip_t6_test.assert(
    miniapp_features.vip_expiry_reminder_window(
      timestamptz '2026-09-24 02:00:00+00',
      timestamptz '2026-09-23 16:30:00+00'
    ) = 'expires_today',
    'shanghai today across utc date'
  );
  PERFORM vip_t6_test.assert(
    miniapp_features.vip_expiry_reminder_window(
      timestamptz '2026-09-27 02:00:00+00',
      timestamptz '2026-09-23 16:30:00+00'
    ) = 'expiring_soon',
    'shanghai plus 3 across utc date'
  );
  PERFORM vip_t6_test.assert(
    miniapp_features.vip_expiry_reminder_window(
      timestamptz '2026-09-26 02:00:00+00',
      timestamptz '2026-09-23 16:30:00+00'
    ) IS NULL,
    'two shanghai days do not send'
  );
  PERFORM vip_t6_test.assert(
    miniapp_features.vip_expiry_reminder_window(
      timestamptz '2026-09-28 02:00:00+00',
      timestamptz '2026-09-23 16:30:00+00'
    ) IS NULL,
    'four shanghai days do not send'
  );
  PERFORM vip_t6_test.assert(
    miniapp_features.vip_expiry_reminder_window(
      timestamptz '2028-02-29 04:00:00+00',
      timestamptz '2028-02-25 16:00:00+00'
    ) = 'expiring_soon',
    'leap day plus 3'
  );
  PERFORM vip_t6_test.assert(
    miniapp_features.vip_expiry_reminder_window(
      timestamptz '2028-02-29 04:00:00+00',
      timestamptz '2028-02-26 16:00:00+00'
    ) IS NULL,
    'leap day plus 2 does not send'
  );
  PERFORM vip_t6_test.assert(
    miniapp_features.vip_expiry_reminder_window(
      timestamptz '2026-02-01 02:00:00+00',
      timestamptz '2026-01-28 16:00:00+00'
    ) = 'expiring_soon',
    'month end plus 3'
  );
  PERFORM vip_t6_test.assert(
    miniapp_features.vip_expiry_reminder_window(
      timestamptz '2026-01-31 02:00:00+00',
      timestamptz '2026-01-28 16:00:00+00'
    ) IS NULL,
    'month end plus 2 does not send'
  );
  PERFORM vip_t6_test.assert(
    miniapp_features.vip_expiry_reminder_window(
      timestamptz '2027-01-01 02:00:00+00',
      timestamptz '2026-12-28 16:00:00+00'
    ) = 'expiring_soon',
    'year end plus 3'
  );
  PERFORM vip_t6_test.assert(
    miniapp_features.vip_expiry_reminder_window(
      timestamptz '2026-12-31 02:00:00+00',
      timestamptz '2026-12-28 16:00:00+00'
    ) IS NULL,
    'year end plus 2 does not send'
  );
  PERFORM vip_t6_test.assert(
    (timestamptz '2026-01-15 00:00:00+08' AT TIME ZONE 'Asia/Shanghai') = timestamp '2026-01-15 00:00:00'
    AND (timestamptz '2026-07-15 00:00:00+08' AT TIME ZONE 'Asia/Shanghai') = timestamp '2026-07-15 00:00:00',
    'shanghai offset stays +08 in winter and summer'
  );

  INSERT INTO app_core.users (id) VALUES (u_soon), (u_other), (u_today_a), (u_today_b);
  INSERT INTO billing.vip_memberships (user_id, valid_from, valid_until, last_plan_id) VALUES
    (u_soon, v_soon - interval '7 days', v_soon, 'week'),
    (u_other, v_plus2 - interval '7 days', v_plus2, 'month'),
    (u_today_a, v_today - interval '7 days', v_today, 'week'),
    (u_today_b, v_today - interval '7 days', v_today, 'week');

  v_json := miniapp_features.insert_due_vip_expiry_reminder(u_soon);
  PERFORM vip_t6_test.assert(v_json->>'status' = 'inserted', 'three day reminder inserted');
  v_json := miniapp_features.insert_due_vip_expiry_reminder(u_soon);
  PERFORM vip_t6_test.assert(v_json->>'status' = 'already_inserted', 'same cycle same kind deduped');
  SELECT count(*) INTO v_count
  FROM miniapp_features.notifications
  WHERE user_id = u_soon AND kind = 'vip_expiry';
  PERFORM vip_t6_test.assert(v_count = 1, 'one row after rerun');

  SELECT title, body, action_path, kind, scope, business_key, metadata
  INTO v_title, v_body, v_path, v_kind, v_scope, v_key, v_meta
  FROM miniapp_features.notifications
  WHERE user_id = u_soon AND kind = 'vip_expiry';
  v_date := to_char(v_soon AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD');
  PERFORM vip_t6_test.assert(v_title = 'VIP 即将到期', 'soon title');
  PERFORM vip_t6_test.assert(v_body = format('您的 VIP 将于 %s（北京时间）到期。', v_date), 'soon body');
  PERFORM vip_t6_test.assert(v_path = '/vip' AND v_kind = 'vip_expiry' AND v_scope = 'official', 'official reminder shape');
  PERFORM vip_t6_test.assert(v_meta->>'reminder_window' = 'expiring_soon', 'metadata window');
  PERFORM vip_t6_test.assert(
    v_key = miniapp_features.vip_expiry_reminder_business_key(u_soon, v_soon, 'expiring_soon'),
    'business key uses locked valid_until'
  );
  v_old_body := v_body;
  v_old_key := v_key;
  v_old_meta := v_meta;

  UPDATE billing.vip_memberships
  SET valid_until = v_plus2, valid_from = v_plus2 - interval '7 days'
  WHERE user_id = u_other;
  v_json := miniapp_features.insert_due_vip_expiry_reminder(u_other);
  PERFORM vip_t6_test.assert(v_json->>'status' = 'skipped_window', 'two days skipped');
  UPDATE billing.vip_memberships
  SET valid_until = v_plus4, valid_from = v_plus4 - interval '7 days'
  WHERE user_id = u_other;
  v_json := miniapp_features.insert_due_vip_expiry_reminder(u_other);
  PERFORM vip_t6_test.assert(v_json->>'status' = 'skipped_window', 'four days skipped');
  UPDATE billing.vip_memberships
  SET valid_until = v_yesterday, valid_from = v_yesterday - interval '7 days'
  WHERE user_id = u_other;
  v_json := miniapp_features.insert_due_vip_expiry_reminder(u_other);
  PERFORM vip_t6_test.assert(v_json->>'status' = 'skipped_window', 'expired skipped');
  SELECT count(*) INTO v_count FROM miniapp_features.notifications WHERE user_id = u_other;
  PERFORM vip_t6_test.assert(v_count = 0, 'out of window writes nothing');

  v_json := miniapp_features.insert_due_vip_expiry_reminder(u_miss);
  PERFORM vip_t6_test.assert(v_json->>'status' = 'skipped_missing', 'missing membership skipped');

  UPDATE billing.vip_memberships
  SET valid_until = v_far, valid_from = now() - interval '1 day'
  WHERE user_id = u_soon;
  v_json := miniapp_features.insert_due_vip_expiry_reminder(u_soon);
  PERFORM vip_t6_test.assert(v_json->>'status' = 'skipped_window', 'renewed cycle is not in the old window');
  SELECT title, body, business_key, metadata
  INTO v_title, v_body, v_key, v_meta
  FROM miniapp_features.notifications
  WHERE user_id = u_soon AND kind = 'vip_expiry';
  PERFORM vip_t6_test.assert(
    v_body = v_old_body AND v_key = v_old_key AND v_meta = v_old_meta AND v_title = 'VIP 即将到期',
    'sent history is not rewritten'
  );

  UPDATE billing.vip_memberships
  SET valid_until = v_today, valid_from = v_today - interval '7 days'
  WHERE user_id = u_soon;
  v_json := miniapp_features.insert_due_vip_expiry_reminder(u_soon);
  PERFORM vip_t6_test.assert(v_json->>'status' = 'inserted', 'new cycle can send expires_today');
  SELECT count(*) INTO v_count FROM miniapp_features.notifications WHERE user_id = u_soon AND kind = 'vip_expiry';
  PERFORM vip_t6_test.assert(v_count = 2, 'different cycles do not collide');
  SELECT title, body INTO v_title, v_body
  FROM miniapp_features.notifications
  WHERE user_id = u_soon AND metadata->>'reminder_window' = 'expiring_soon';
  PERFORM vip_t6_test.assert(v_title = 'VIP 即将到期' AND v_body = v_old_body, 'old cycle body remains');
  SELECT title INTO v_title
  FROM miniapp_features.notifications
  WHERE user_id = u_soon AND metadata->>'reminder_window' = 'expires_today';
  PERFORM vip_t6_test.assert(v_title = 'VIP 今日到期', 'today title');

  UPDATE billing.vip_memberships
  SET valid_until = now() + interval '40 days',
      valid_from = now() - interval '1 day'
  WHERE user_id NOT IN (u_today_a, u_today_b, u_soon);

  SELECT c.user_id INTO v_id
  FROM miniapp_features.list_vip_expiry_reminder_candidates(1, NULL) AS c(user_id)
  ORDER BY c.user_id;
  PERFORM vip_t6_test.assert(v_id = u_today_a, 'batch limit returns the first unsent user');
  SELECT c.user_id INTO v_id
  FROM miniapp_features.list_vip_expiry_reminder_candidates(1, u_today_a) AS c(user_id);
  PERFORM vip_t6_test.assert(v_id = u_today_b, 'cursor returns the next user');
  PERFORM vip_t6_test.assert(
    NOT EXISTS (
      SELECT 1 FROM miniapp_features.list_vip_expiry_reminder_candidates(100, NULL) AS c(user_id)
      WHERE c.user_id = u_soon
    ),
    'already sent today reminder is not listed again'
  );

  BEGIN
    PERFORM miniapp_features.list_vip_expiry_reminder_candidates(0, NULL);
    PERFORM vip_t6_test.assert(false, 'limit 0 should fail');
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;
  BEGIN
    PERFORM miniapp_features.list_vip_expiry_reminder_candidates(101, NULL);
    PERFORM vip_t6_test.assert(false, 'limit 101 should fail');
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;

  PERFORM vip_t6_test.assert(
    NOT has_function_privilege('anon', 'miniapp_features.insert_due_vip_expiry_reminder(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'miniapp_features.insert_due_vip_expiry_reminder(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'miniapp_features.list_vip_expiry_reminder_candidates(integer,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'miniapp_features.list_vip_expiry_reminder_candidates(integer,uuid)', 'EXECUTE')
    AND has_function_privilege('service_role', 'miniapp_features.insert_due_vip_expiry_reminder(uuid)', 'EXECUTE')
    AND has_function_privilege('service_role', 'miniapp_features.list_vip_expiry_reminder_candidates(integer,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'miniapp_features.insert_vip_expiry_reminder(uuid,text,timestamptz,text,text,text)', 'EXECUTE'),
    'reminder execute grants'
  );
  PERFORM vip_t6_test.assert(
    EXISTS (
      SELECT 1 FROM pg_proc
      WHERE oid = 'miniapp_features.insert_due_vip_expiry_reminder(uuid)'::regprocedure
        AND prosecdef
        AND 'search_path=pg_catalog' = ANY (proconfig)
    )
    AND EXISTS (
      SELECT 1 FROM pg_proc
      WHERE oid = 'miniapp_features.list_vip_expiry_reminder_candidates(integer,uuid)'::regprocedure
        AND prosecdef
        AND 'search_path=pg_catalog' = ANY (proconfig)
    )
    AND to_regprocedure('miniapp_features.insert_vip_expiry_reminder(uuid,text,timestamptz,text,text,text)') IS NOT NULL,
    'definer search_path and old signature remain'
  );
  PERFORM vip_t6_test.assert(
    EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'miniapp_features' AND indexname = 'uq_notifications_business_key'
    ),
    'business key unique index remains'
  );

  v_window := miniapp_features.vip_expiry_reminder_window(v_today, now());
  PERFORM vip_t6_test.assert(v_window = 'expires_today', 'relative today window');
  v_window := miniapp_features.vip_expiry_reminder_window(v_soon, now());
  PERFORM vip_t6_test.assert(v_window = 'expiring_soon', 'relative three day window');

  RETURN 'vip t6 scenarios passed';
END;
$$;

SELECT vip_t6_test.run();
