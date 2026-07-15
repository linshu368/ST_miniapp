-- 033: 锁定平台预设字段
--
-- platform_presets.preset_payload 是平台唯一的预设真相。用户 B 段不得覆盖
-- 其映射到 oai_settings 的任一字段，否则 preset 指针与最终请求 messages 会不一致。
--
-- platform_settings 是 append-only 快照；本迁移追加一个版本，不原地修改历史行。

DO $$
DECLARE
  prev          st_platform.platform_settings%ROWTYPE;
  locked_paths  JSONB;
  new_version   BIGINT;
  new_hash      TEXT;
BEGIN
  SELECT *
    INTO prev
    FROM st_platform.platform_settings
   ORDER BY platform_version DESC
   LIMIT 1;

  IF prev IS NULL THEN
    RAISE EXCEPTION 'Cannot lock preset fields: st_platform.platform_settings is empty';
  END IF;

  SELECT COALESCE(jsonb_agg(item.value ORDER BY item.ordinality), '[]'::jsonb)
    INTO locked_paths
    FROM jsonb_array_elements(prev.writable_paths) WITH ORDINALITY AS item(value, ordinality)
   WHERE (item.value->>'path') <> 'oai_settings'
     AND (item.value->>'path') !~ '^oai_settings\.(temp_openai|freq_pen_openai|pres_pen_openai|top_p_openai|top_k_openai|top_a_openai|min_p_openai|repetition_penalty_openai|max_context_unlocked|tool_reasoning_mode|openai_max_context|openai_max_tokens|names_behavior|send_if_empty|impersonation_prompt|new_chat_prompt|new_group_chat_prompt|new_example_chat_prompt|continue_nudge_prompt|bias_preset_selected|wi_format|scenario_format|personality_format|group_nudge_prompt|stream_openai|prompts|prompt_order|assistant_prefill|assistant_impersonation|use_sysprompt|squash_system_messages|media_inlining|inline_image_quality|continue_prefill|continue_postfix|function_calling|tool_call_recurse_limit|show_thoughts|reasoning_effort|verbosity|enable_web_search|seed|n|request_images|request_image_aspect_ratio|request_image_resolution|extensions)(\.|$)';

  new_version := prev.platform_version + 1;
  new_hash := encode(
    digest(
      st_platform.canonical_jsonb(
        jsonb_build_object(
          'platform_version', new_version,
          'settings_jsonb',   prev.settings_jsonb,
          'writable_paths',   locked_paths
        )
      ),
      'sha256'
    ),
    'hex'
  );

  INSERT INTO st_platform.platform_settings (
    platform_version, settings_jsonb, writable_paths,
    content_hash, created_by, note
  ) VALUES (
    new_version,
    prev.settings_jsonb,
    locked_paths,
    new_hash,
    'migration:033_lock_preset_fields',
    '锁定预设映射字段，用户设置不可覆盖平台完整预设'
  );
END;
$$;
