-- domain: miniapp_features
-- 每个账户按北京时间自然日签到一次；不修改奖励配置、历史事实或钱包余额。
-- TEST 验证后，先迁移再部署 Backend/Frontend。无新表、索引、cron 或回填。
-- 恢复：受审阅 forward-fix 同步 RPC/Backend 为旧 24h 资格；保留已领余额和流水。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
  v_old_parts text[] := ARRAY[
    'IF FOUND AND v_last_claimed_at > v_claimed_at - interval ''24 hours'' THEN',
    '''next_claim_at'', v_claimed_at + interval ''24 hours''',
    '  v_vip_active := FOUND AND v_membership.valid_until > v_claimed_at;'
  ];
  v_new_parts text[] := ARRAY[
    'IF FOUND AND v_last_claimed_at >= (date_trunc(''day'', v_claimed_at AT TIME ZONE ''Asia/Shanghai'') AT TIME ZONE ''Asia/Shanghai'') THEN',
    '''next_claim_at'', (date_trunc(''day'', v_claimed_at AT TIME ZONE ''Asia/Shanghai'') + interval ''1 day'') AT TIME ZONE ''Asia/Shanghai''',
    E'  -- Check the business date after waiting for account/membership locks.\n  v_claimed_at := clock_timestamp();\n  v_vip_active := FOUND AND v_membership.valid_until > v_claimed_at;'
  ];
  v_index integer;
BEGIN
  SELECT replace(pg_get_functiondef(p.oid), E'\r\n', E'\n')
  INTO v_definition
  FROM pg_proc p
  WHERE p.oid = to_regprocedure('miniapp_features.claim_daily_checkin(uuid)')
    AND p.prorettype = 'jsonb'::regtype
    AND p.prosecdef
    AND p.proconfig @> ARRAY['search_path=pg_catalog'];
  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'Unexpected claim_daily_checkin signature/security shape';
  END IF;

  -- A complete prior application is a no-op; partial or unknown shapes fail closed.
  IF position(v_new_parts[1] IN v_definition) > 0
     AND position(v_new_parts[2] IN v_definition) > 0
     AND position(v_new_parts[3] IN v_definition) > 0 THEN
    RETURN;
  END IF;

  FOR v_index IN 1..array_length(v_old_parts, 1) LOOP
    v_old := v_old_parts[v_index];
    v_new := v_new_parts[v_index];
    IF array_length(string_to_array(v_definition, v_old), 1) <> 2 THEN
      RAISE EXCEPTION 'Unexpected claim_daily_checkin time anchor %', v_index;
    END IF;
    v_definition := replace(v_definition, v_old, v_new);
  END LOOP;
  -- CREATE OR REPLACE retains the existing function owner, ACL and dependencies.
  EXECUTE v_definition;
END;
$migration$;

COMMIT;
