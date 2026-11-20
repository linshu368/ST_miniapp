-- Domain: billing（角色卡免费额度）+ experience（首字上报）+ admin（托管配置校验）——数据库重组阶段 6b-1q 收缩。
-- 计划见 .trellis/tasks/11-19-db-reorg-p6-billing/design.md（6b-1q）。
--
-- 用户 11-20 定退役角色卡免费额度。目录里 0 个免费模型，免费聊天由畅聊承担。
-- 退役代码（后端不再预留 / 终结额度，前端不再查额度，运营平台去掉两个配置入口）已发布。
-- 校验放宽在 20261120_db_reorg_p6b1q_free_model_expand.sql。
-- 本文件（退役代码发布后执行）：
--   0. 前置守卫：当前目录没有免费模型；额度表近 1 小时没有新写入。表已删则整体空操作。
--   1. 两个函数去掉额度相关段落，守卫生产原文 md5，每处恰好替换一次，核对结果 md5；已是新版本跳过：
--      - experience.report_chat_first_token：去掉"截止时释放额度预留"整段与随之无用的 v_charge_id；
--      - admin.validate_managed_config_value：去掉两个 key 的 WHEN 分支。
--      提交后等 5 秒，让排队中的旧函数调用走完。
--   2. 退役两个托管 key：登记表 retired_at 设为当前时间（草稿 / 发布历史照旧可引用），删 runtime_config 行。
--   3. 守卫：没有其他函数引用额度表；然后删两个额度函数、弹窗校验函数和两张表。
--      遗留的 34 条 reserved 决定随表删除：免费轮本就不扣钱，R1 不受影响。
-- billing.charge_llm_usage 里 free_quota / free_quota_exhausted 类别名留到 6b-1c 重写该函数时去掉。
--
-- Verify: bash scripts/test-db-reorg-p6b1q-free-model-contract.sh
-- Release: 退役代码发布 → TEST → Production。

DO $guard$
DECLARE
  v_free_models bigint;
  v_recent bigint;
BEGIN
  IF to_regclass('billing.character_free_chat_quota_decisions') IS NULL THEN
    RETURN;
  END IF;
  SELECT count(*) INTO v_free_models
  FROM app_core.runtime_config rc,
       jsonb_path_query(rc.value, '$.tiers[*].models[*] ? (@.is_free == true)')
  WHERE rc.key = 'llm_model_catalog';
  IF v_free_models > 0 THEN
    RAISE EXCEPTION 'p6b1q-contract: % free models are still in llm_model_catalog; refusing', v_free_models;
  END IF;
  SELECT count(*) INTO v_recent FROM billing.character_free_chat_quota_decisions
  WHERE created_at > now() - interval '1 hour' OR updated_at > now() - interval '1 hour';
  IF v_recent > 0 THEN
    RAISE EXCEPTION 'p6b1q-contract: % quota decisions written in the last hour; release the retirement code first', v_recent;
  END IF;
END
$guard$;

DO $patch$
DECLARE
  r record;
  v_md5 text;
  v_def text;
  v_done int := 0;
BEGIN
  SET LOCAL lock_timeout = '5s';
  FOR r IN SELECT * FROM (VALUES
    ('experience.report_chat_first_token(uuid,uuid,jsonb)', 'ecdab7e19b7ad4868d5f0a074a1553d8', '4351ecbbe18b2b0355e17e3fddbd1717',
     ARRAY[$o1$  -- Release a genuine cutoff's reservation in this same receipt transaction.
  -- Departure/background and explicit user stop do not become free cancellations.
  IF r.requires_visible_token AND v_outcome IN ('timed_out','not_observed')
    AND COALESCE(v_reason,'') <> 'cancelled'
    AND (NOT r.recoverable_delivery OR v_delivery_failed) THEN
    SELECT llm_charge_id INTO v_charge_id FROM experience.chat_history WHERE id=r.chat_history_id;
    IF EXISTS(SELECT 1 FROM billing.character_free_chat_quota_decisions
              WHERE charge_key=v_charge_id AND status='reserved') THEN
      PERFORM billing.finalize_character_free_chat_round(v_charge_id,false);
    END IF;
  END IF;
$o1$, $o2$v_reason text; v_charge_id uuid;
$o2$],
     ARRAY['', $n2$v_reason text;
$n2$]),
    ('admin.validate_managed_config_value(text,jsonb,text)', '950822be56d6075c4d633c3e7f1d9856', '41fc722cb156ed82fb511b9db5ab2cf4',
     ARRAY[$o3$    WHEN 'miniapp_character_free_chat_quota_limit' THEN
      IF p_value IS NULL
         OR jsonb_typeof(p_value) IS DISTINCT FROM 'number'
         OR (p_value #>> '{}')::NUMERIC <> trunc((p_value #>> '{}')::NUMERIC)
         OR (p_value #>> '{}')::NUMERIC < 1 THEN
        RAISE EXCEPTION
          'miniapp_character_free_chat_quota_limit must be a positive JSON integer'
          USING ERRCODE = '22023';
      END IF;

    WHEN 'miniapp_free_quota_exhausted_dialog_config' THEN
      PERFORM admin.validate_free_quota_exhausted_dialog_config(p_value);

$o3$],
     ARRAY[''])
  ) AS t(fn, old_md5, new_md5, olds, news) LOOP
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = r.fn::regprocedure;
    IF v_md5 = r.new_md5 THEN
      CONTINUE;
    ELSIF v_md5 <> r.old_md5 THEN
      RAISE EXCEPTION 'p6b1q-contract: % drifted (md5 %), refusing', r.fn, v_md5;
    END IF;
    v_def := pg_get_functiondef(r.fn::regprocedure);
    FOR i IN 1 .. array_length(r.olds, 1) LOOP
      IF (length(v_def) - length(replace(v_def, r.olds[i], ''))) / length(r.olds[i]) <> 1 THEN
        RAISE EXCEPTION 'p6b1q-contract: anchor % not found exactly once in %', i, r.fn;
      END IF;
      v_def := replace(v_def, r.olds[i], r.news[i]);
    END LOOP;
    EXECUTE v_def;
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = r.fn::regprocedure;
    IF v_md5 <> r.new_md5 THEN
      RAISE EXCEPTION 'p6b1q-contract: unexpected md5 % for %', v_md5, r.fn;
    END IF;
    v_done := v_done + 1;
  END LOOP;
  RAISE NOTICE 'p6b1q-contract: % functions no longer reference the free quota', v_done;
END
$patch$;

SELECT pg_sleep(5);

DO $retire$
DECLARE
  v_retired bigint;
  v_rows bigint;
BEGIN
  UPDATE admin.managed_config_keys SET retired_at = now()
  WHERE config_key IN ('miniapp_character_free_chat_quota_limit', 'miniapp_free_quota_exhausted_dialog_config')
    AND retired_at IS NULL;
  GET DIAGNOSTICS v_retired = ROW_COUNT;
  DELETE FROM app_core.runtime_config
  WHERE key IN ('miniapp_character_free_chat_quota_limit', 'miniapp_free_quota_exhausted_dialog_config');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'p6b1q-contract: % keys retired, % runtime_config rows deleted', v_retired, v_rows;
END
$retire$;

DO $drop$
DECLARE
  v_refs text;
  v_quotas bigint;
  v_decisions bigint;
  v_reserved bigint;
BEGIN
  IF to_regclass('billing.character_free_chat_quota_decisions') IS NULL THEN
    RAISE NOTICE 'p6b1q-contract: free quota tables already dropped';
    RETURN;
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_refs
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND (p.prosrc ~ 'character_free_chat_quota' OR p.prosrc ~ 'free_chat_round'
         OR p.prosrc ~ 'validate_free_quota_exhausted_dialog_config')
    AND p.oid NOT IN ('billing.reserve_character_free_chat_round(uuid,uuid,uuid,integer)'::regprocedure,
                      'billing.finalize_character_free_chat_round(uuid,boolean)'::regprocedure,
                      'admin.validate_free_quota_exhausted_dialog_config(jsonb)'::regprocedure);
  IF v_refs IS NOT NULL THEN
    RAISE EXCEPTION 'p6b1q-contract: functions still reference the free quota: %', v_refs;
  END IF;
  SELECT count(*) INTO v_quotas FROM billing.character_free_chat_quotas;
  SELECT count(*), count(*) FILTER (WHERE status = 'reserved') INTO v_decisions, v_reserved
  FROM billing.character_free_chat_quota_decisions;
  SET LOCAL lock_timeout = '5s';
  DROP FUNCTION billing.reserve_character_free_chat_round(uuid, uuid, uuid, integer);
  DROP FUNCTION billing.finalize_character_free_chat_round(uuid, boolean);
  DROP FUNCTION admin.validate_free_quota_exhausted_dialog_config(jsonb);
  DROP TABLE billing.character_free_chat_quota_decisions;
  DROP TABLE billing.character_free_chat_quotas;
  RAISE NOTICE 'p6b1q-contract: dropped quota tables (% quota rows, % decisions, % still reserved) and 3 functions',
    v_quotas, v_decisions, v_reserved;
END
$drop$;
