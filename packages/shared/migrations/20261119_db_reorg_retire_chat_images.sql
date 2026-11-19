-- Domain: experience / billing / admin（聊天配图）——数据库重组 4b：聊天配图下线（用户 11-19 确认）。
-- 计划见 .trellis/tasks/11-18-db-reorg-p4-jobs/design.md（4b）。
--
-- 功能 9-29 起关闭（image_generation_enabled=false），之后没有新数据；后端发布（同一 PR 的代码）已删除
-- 配图 worker（每约 3 秒空轮询 claim_chat_image_jobs）、接口、运营台配置页与模型测试。本文件在发布后执行：
--   1. 守卫：表里没有未结束的任务（只允许 ready / failed / failed_unknown / draft_ready / draft_failed）、没有租约。
--   2. 15 个配图配置 key 退役（admin.managed_config_keys.retired_at），删其 runtime_config 行（生效值，含
--      image_text_model_config 里的 API Key）。草稿是发布记录的来源（config_releases.source_draft_id 外键 RESTRICT），
--      与发布历史一起保留；退役 key 的草稿不能再保存或发布。
--   3. admin.validate_managed_config_value 去掉这些 key 的分支（退役后首句已拒绝，分支是死代码）：
--      守卫生产原文 md5 969279438aec4fde02a547dc7caa21ff，逐段恰好一处替换，结果 md5 f23fcee068b6d3e2da2efe91b7c2bf7a；
--      已是新版本时跳过。
--   4. 删函数 experience.claim_chat_image_jobs、billing.settle_image_generation（只被配图链路调用）、
--      admin.validate_image_generation_config_value、admin.validate_image_text_model_config。
--   5. experience.chat_message_images 只读归档：收回 anon / authenticated / service_role 的全部权限。
--      274 行与扣费流水（billing.wallet_ledger）、存储桶 miniapp-chat-images 都保留，不删数据。
-- 一个 DO 块，全部同进同退；重跑只打印已完成。
--
-- Verify: bash scripts/test-db-reorg-retire-chat-images.sh
-- Release: 代码发布（Railway 主服务不再轮询）后 TEST -> Production。
-- Recovery: 需要恢复时按 20260914 起的配图迁移重建函数、UPDATE retired_at = NULL 并写回配置；数据未删。

DO $retire_chat_images$
DECLARE
  v_keys CONSTANT text[] := ARRAY[
    'image_generation_enabled',
    'image_generation_credits',
    'image_price_label',
    'image_text_model_config',
    'image_prompt_policy',
    'image_default_art_style',
    'image_description_system_prompt',
    'image_width',
    'image_height',
    'image_max_prompt_chars',
    'image_max_output_bytes',
    'image_prompt_over_limit_hint',
    'image_description_failed_hint',
    'image_generation_failed_hint',
    'image_failed_unknown_hint'
  ];
  v_orig_md5 CONSTANT text := '969279438aec4fde02a547dc7caa21ff';
  v_new_md5 CONSTANT text := 'f23fcee068b6d3e2da2efe91b7c2bf7a';
  v_fn CONSTANT regprocedure := 'admin.validate_managed_config_value(text,jsonb,text)'::regprocedure;
  v_md5 text;
  v_def text;
  v_old text;
  v_retired integer := 0;
  v_runtime integer := 0;
  v_dropped integer := 0;
BEGIN
  SET LOCAL lock_timeout = '5s';

  -- 1. No job may still be in flight.
  IF to_regclass('experience.chat_message_images') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM experience.chat_message_images
      WHERE status NOT IN ('ready', 'failed', 'failed_unknown', 'draft_ready', 'draft_failed')
         OR lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'chat images: unfinished or leased jobs exist, refusing';
    END IF;
  END IF;

  -- 2. Retire the configuration keys.
  UPDATE admin.managed_config_keys
     SET retired_at = COALESCE(retired_at, now()),
         note = COALESCE(note, '聊天配图下线（20261119 退役）')
   WHERE config_key = ANY (v_keys) AND retired_at IS NULL;
  GET DIAGNOSTICS v_retired = ROW_COUNT;
  DELETE FROM app_core.runtime_config WHERE key = ANY (v_keys);
  GET DIAGNOSTICS v_runtime = ROW_COUNT;

  -- 3. Validator: drop the dead branches.
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_fn;
  IF v_md5 = v_orig_md5 THEN
    v_def := pg_get_functiondef(v_fn);
    FOREACH v_old IN ARRAY ARRAY[
      $s1$    'llm_provider_routing_config', 'image_text_model_config',
$s1$,
      $s2$    'image_generation_enabled', 'image_generation_credits', 'image_price_label', 'image_default_art_style',
    'image_width', 'image_height', 'image_max_prompt_chars', 'image_max_output_bytes', 'image_prompt_policy',
    'image_prompt_over_limit_hint', 'image_description_failed_hint', 'image_generation_failed_hint',
    'image_failed_unknown_hint',
$s2$,
      $s3$    WHEN 'image_generation_enabled', 'image_generation_credits', 'image_price_label', 'image_default_art_style',
         'image_width', 'image_height', 'image_max_prompt_chars', 'image_max_output_bytes', 'image_prompt_policy',
         'image_prompt_over_limit_hint', 'image_description_failed_hint', 'image_generation_failed_hint',
         'image_failed_unknown_hint' THEN
      PERFORM admin.validate_image_generation_config_value(p_config_key, p_value);

    WHEN 'image_text_model_config' THEN
      PERFORM admin.validate_image_text_model_config(p_value);

    WHEN 'image_description_system_prompt' THEN
      IF p_value IS NOT NULL OR p_text_value IS NULL OR char_length(btrim(p_text_value)) = 0
         OR char_length(p_text_value) > 12000 THEN
        RAISE EXCEPTION 'image_description_system_prompt must use a nonempty text_value up to 12000 chars'
          USING ERRCODE = '22023';
      END IF;

$s3$,
      $s4$    -- 图片：生成、描述、广场、视频广场 $s4$
    ] LOOP
      IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
        RAISE EXCEPTION 'validate_managed_config_value: anchor not found exactly once: %', left(v_old, 60);
      END IF;
    END LOOP;
    v_def := replace(v_def, $s1$    'llm_provider_routing_config', 'image_text_model_config',
$s1$, $r1$    'llm_provider_routing_config',
$r1$);
    v_def := replace(v_def, $s2$    'image_generation_enabled', 'image_generation_credits', 'image_price_label', 'image_default_art_style',
    'image_width', 'image_height', 'image_max_prompt_chars', 'image_max_output_bytes', 'image_prompt_policy',
    'image_prompt_over_limit_hint', 'image_description_failed_hint', 'image_generation_failed_hint',
    'image_failed_unknown_hint',
$s2$, '');
    v_def := replace(v_def, $s3$    WHEN 'image_generation_enabled', 'image_generation_credits', 'image_price_label', 'image_default_art_style',
         'image_width', 'image_height', 'image_max_prompt_chars', 'image_max_output_bytes', 'image_prompt_policy',
         'image_prompt_over_limit_hint', 'image_description_failed_hint', 'image_generation_failed_hint',
         'image_failed_unknown_hint' THEN
      PERFORM admin.validate_image_generation_config_value(p_config_key, p_value);

    WHEN 'image_text_model_config' THEN
      PERFORM admin.validate_image_text_model_config(p_value);

    WHEN 'image_description_system_prompt' THEN
      IF p_value IS NOT NULL OR p_text_value IS NULL OR char_length(btrim(p_text_value)) = 0
         OR char_length(p_text_value) > 12000 THEN
        RAISE EXCEPTION 'image_description_system_prompt must use a nonempty text_value up to 12000 chars'
          USING ERRCODE = '22023';
      END IF;

$s3$, '');
    v_def := replace(v_def, $s4$    -- 图片：生成、描述、广场、视频广场 $s4$, $r4$    -- 图片：广场、视频广场 $r4$);
    EXECUTE v_def;
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_fn;
    IF v_md5 <> v_new_md5 THEN
      RAISE EXCEPTION 'validate_managed_config_value: unexpected result md5 %', v_md5;
    END IF;
  ELSIF v_md5 <> v_new_md5 THEN
    RAISE EXCEPTION 'validate_managed_config_value drifted (md5 %), refusing', v_md5;
  END IF;

  -- 4. Functions only the chat image pipeline used.
  IF to_regprocedure('experience.claim_chat_image_jobs(text,integer,integer)') IS NOT NULL THEN
    DROP FUNCTION experience.claim_chat_image_jobs(text, integer, integer); v_dropped := v_dropped + 1;
  END IF;
  IF to_regprocedure('billing.settle_image_generation(uuid,uuid,numeric,jsonb)') IS NOT NULL THEN
    DROP FUNCTION billing.settle_image_generation(uuid, uuid, numeric, jsonb); v_dropped := v_dropped + 1;
  END IF;
  IF to_regprocedure('admin.validate_image_generation_config_value(text,jsonb)') IS NOT NULL THEN
    DROP FUNCTION admin.validate_image_generation_config_value(text, jsonb); v_dropped := v_dropped + 1;
  END IF;
  IF to_regprocedure('admin.validate_image_text_model_config(jsonb)') IS NOT NULL THEN
    DROP FUNCTION admin.validate_image_text_model_config(jsonb); v_dropped := v_dropped + 1;
  END IF;

  -- 5. Read-only archive.
  IF to_regclass('experience.chat_message_images') IS NOT NULL THEN
    REVOKE ALL ON experience.chat_message_images FROM anon, authenticated, service_role;
    COMMENT ON TABLE experience.chat_message_images IS
      '聊天配图（9-29 关闭、11-19 下线）只读归档：不再有写入方与读取方；扣费以 billing.wallet_ledger 为准，图片文件在存储桶 miniapp-chat-images。';
  END IF;

  RAISE NOTICE 'retire chat images: keys retired %, runtime rows deleted %, functions dropped %',
    v_retired, v_runtime, v_dropped;
END
$retire_chat_images$;
