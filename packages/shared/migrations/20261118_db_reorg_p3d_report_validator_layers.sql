-- Domain: admin（运营托管配置的写入校验）——数据库重组阶段 3d 的只读前置报告。
-- 计划见 .trellis/tasks/11-17-db-reorg-p3-user-state/design.md 3d。
--
-- 背景：TEST 执行 20261118_db_reorg_p3d_flatten_config_validator.sql 时守卫报 6 层与生产不同（去掉 \r 后仍不同），
--   TEST 不在只读结构采集范围内。本文件不改任何对象，只把与生产内容不同的层以 NOTICE 打到执行日志
--   （md5、长度、完整函数体），据此决定 TEST 的前置处理。生产 16 层与写迁移时一致，执行为空操作。
--
-- Verify: 看 workflow 日志里的 NOTICE。
-- Release: TEST -> Production（生产为空操作，只为两边账本一致）。
-- Recovery: 无改动，无需恢复。
BEGIN;
SET LOCAL statement_timeout = '30s';

DO $report$
DECLARE
  r record;
  v_src text;
  v_count integer := 0;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('validate_managed_config_value', 'f2a182f9fdf8acf3db0a3c8065765b1f'),
    ('validate_managed_config_value_before_drive_mode', 'c59a939fb223ce5efa9771fba280c2d2'),
    ('validate_managed_config_value_before_free_zone', 'cb7231a5a388e44c0953573d8a98672d'),
    ('validate_managed_config_value_before_story_memory', '47560512792fcaf2e17a11fe4dadd7d0'),
    ('validate_managed_config_value_before_lobby_rotation', 'e5437d86931ebc68e6083bae2fe8ca0f'),
    ('validate_managed_config_value_before_creator_review', '1b2e7c9a07f543cd38de0f96363517c3'),
    ('validate_managed_config_value_before_checkin_tiers', '54d69e3bb4034cf09893a665b6971cf2'),
    ('validate_managed_config_value_before_reply_styles', 'dfa1bd840e718465e29a0c327d9ef2bf'),
    ('validate_managed_config_value_before_image_plaza_tags_feature', '89ac9b618d02c95f2f8f489ab2b10fef'),
    ('validate_managed_config_value_before_image_plaza', 'ccefb9ee6d1de89e9c05ac52909f1211'),
    ('validate_managed_config_value_before_instruction_slots', 'caca71a531ae7759326c95fd140d7ed3'),
    ('validate_managed_config_value_before_rich_reply_protocol', '2b9d6e649cdea5ebd73988d3c508f0fc'),
    ('validate_managed_config_value_before_vip_strategy', 'b2983e9f975228e058e5bb2c5d0562e7'),
    ('validate_managed_config_value_before_provider_routing', '7271d892ab3423eb39c1d776ddc6e0ad'),
    ('validate_managed_config_value_before_payment_prompt', 'f4a48cba8a5cf986322576f2cf86df7c'),
    ('validate_managed_config_value_before_fixed_billing', 'd2621ae91ba2957375abed820d3751bd')
  ) AS t(fn, md5_no_cr)
  LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure('admin.' || r.fn || '(text,jsonb,text)');
    IF v_src IS NULL THEN
      RAISE NOTICE 'p3d layer % is missing', r.fn;
      v_count := v_count + 1;
    ELSIF md5(replace(v_src, E'\r', '')) <> r.md5_no_cr THEN
      RAISE NOTICE 'p3d layer % differs: md5=% md5_no_cr=% length=% body:%', r.fn, md5(v_src),
        md5(replace(v_src, E'\r', '')), length(v_src), replace(v_src, E'\r', '');
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'p3d layers differing from production: %; extra layers: %', v_count,
    (SELECT string_agg(proname, ', ') FROM pg_proc WHERE pronamespace = 'admin'::regnamespace
       AND proname LIKE 'validate\_managed\_config\_value%'
       AND proname NOT IN ('validate_managed_config_value', 'validate_managed_config_value_before_drive_mode',
         'validate_managed_config_value_before_free_zone', 'validate_managed_config_value_before_story_memory',
         'validate_managed_config_value_before_lobby_rotation', 'validate_managed_config_value_before_creator_review',
         'validate_managed_config_value_before_checkin_tiers', 'validate_managed_config_value_before_reply_styles',
         'validate_managed_config_value_before_image_plaza_tags_feature', 'validate_managed_config_value_before_image_plaza',
         'validate_managed_config_value_before_instruction_slots', 'validate_managed_config_value_before_rich_reply_protocol',
         'validate_managed_config_value_before_vip_strategy', 'validate_managed_config_value_before_provider_routing',
         'validate_managed_config_value_before_payment_prompt', 'validate_managed_config_value_before_fixed_billing'));
END
$report$;

COMMIT;
