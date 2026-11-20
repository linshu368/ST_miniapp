-- Domain: admin（运营托管配置校验）
-- VIP 只卖月卡，周卡下线（后端已不列出周卡、不接受周卡下单）。
-- 本迁移只改运营配置校验：发布 vip_plans_config 时只接受 {"month": …}，不再要求带 week。
--   1. admin.validate_vip_plans_config：键必须恰好是 month；
--   2. admin.validate_vip_plan_terms：去掉只对 week 生效的"赠送必须为 0"分支，其余逐字不变。
-- 不动：历史订单 / 会员 / 开通记录里的 week 及其表约束（个别早已过期、已完结的历史数据）；
--   线上现存配置里的 week 由后端读取时丢弃，运营平台下一次发布 vip_plans_config 即清掉。
-- 前置：后端已发布只认月卡的版本（该版本读带 week / 不带 week 的配置都正常）。
-- 执行顺序：TEST → 生产（需确认）；之后在运营平台发布一次只含月卡的 vip_plans_config。
-- 回滚：按 20260923_vip_strategy_config.sql 与 20261105_vip_mixed_rewards.sql 恢复两个函数
--   （回滚前若已发布只含月卡的配置，需先发布回带 week 的配置）。
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_plans text := pg_get_functiondef('admin.validate_vip_plans_config(jsonb)'::regprocedure);
  v_terms text := pg_get_functiondef('admin.validate_vip_plan_terms(jsonb,text)'::regprocedure);
BEGIN
  -- 现行定义应是"恰好 week + month"的版本，或本迁移已执行过的版本
  IF position($m$ARRAY['month','week']$m$ IN v_plans) = 0
     AND position('must contain only month' IN v_plans) = 0 THEN
    RAISE EXCEPTION 'vip month only: admin.validate_vip_plans_config 与预期不符，先核对现行定义';
  END IF;
  -- 赠送字段校验应已是混合赠送（专项 + 通用）版本
  IF position('bonus_main_credits' IN v_terms) = 0
     OR position('assert_vip_json_text' IN v_terms) = 0 THEN
    RAISE EXCEPTION 'vip month only: admin.validate_vip_plan_terms 与预期不符，先核对现行定义';
  END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION admin.validate_vip_plan_terms(p_plan jsonb, p_id text)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_keys TEXT[];
BEGIN
  IF jsonb_typeof(p_plan) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'vip plan % must be an object', p_id USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::TEXT[])
    INTO v_keys
  FROM jsonb_object_keys(p_plan) AS key;
  IF v_keys IS DISTINCT FROM ARRAY['badge_text','bonus_credits','description','duration_days','price_cents','title']
     AND v_keys IS DISTINCT FROM ARRAY['badge_text','bonus_credits','bonus_main_credits','description','duration_days','price_cents','title'] THEN
    RAISE EXCEPTION 'vip plan % has unexpected fields', p_id USING ERRCODE = '22023';
  END IF;
  PERFORM admin.assert_vip_json_int(p_plan->'price_cents', 1, 1000000, p_id || '.price_cents');
  PERFORM admin.assert_vip_json_int(p_plan->'duration_days', 1, 3660, p_id || '.duration_days');
  PERFORM admin.assert_vip_json_int(p_plan->'bonus_credits', 0, 1000000, p_id || '.bonus_credits');
  PERFORM admin.assert_vip_json_int(COALESCE(p_plan->'bonus_main_credits','0'::jsonb), 0, 1000000, p_id || '.bonus_main_credits');
  PERFORM admin.assert_vip_json_text(p_plan->'title', 1, 40, false, p_id || '.title');
  PERFORM admin.assert_vip_json_text(p_plan->'description', 0, 200, true, p_id || '.description');
  PERFORM admin.assert_vip_json_text(p_plan->'badge_text', 1, 40, true, p_id || '.badge_text');
END;
$function$;

CREATE OR REPLACE FUNCTION admin.validate_vip_plans_config(p_value jsonb)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_keys TEXT[];
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'vip_plans_config must be an object' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::TEXT[])
    INTO v_keys
  FROM jsonb_object_keys(p_value) AS key;
  IF v_keys IS DISTINCT FROM ARRAY['month'] THEN
    RAISE EXCEPTION 'vip_plans_config must contain only month' USING ERRCODE = '22023';
  END IF;
  PERFORM admin.validate_vip_plan_terms(p_value->'month', 'month');
END;
$function$;

-- CREATE OR REPLACE 保留原有授权；与 20260923 一致再收一次
REVOKE ALL ON FUNCTION admin.validate_vip_plan_terms(jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_vip_plans_config(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
