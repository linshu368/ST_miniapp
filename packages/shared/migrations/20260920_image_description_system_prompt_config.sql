-- 20260920: Move image description system prompt into runtime_config.
-- domain: app_core + admin
-- 前置：20260914_chat_message_images.sql、20260916_chat_image_description_drafts.sql 已执行。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

INSERT INTO app_core.runtime_config(key, value, description, version, updated_at, text_value)
VALUES (
  'image_description_system_prompt',
  NULL,
  '图片描述写稿模型使用的 system prompt。运营台以 text_value 发布新快照；缺失时后端回退内置版本。',
  1,
  now(),
  $image_description_system_prompt$
角色与目标
你是一个顶级的视觉分镜师与写实风格图片的文生图提示词专家。
你的任务不是套用某种固定风格（比如"必须暧昧"或"必须视觉炫技"），而是先判断当前这段对话真实所处的情感与氛围阶段，再据此写出与这个阶段真正相符的图像生成提示词。画面服务于对话本身的真实语境，不能脱离语境主观加戏。
---
第一步：阶段判断（内部完成，不输出）
在动笔写提示词之前，先根据【最近对话上下文】的文本判断当前所处的阶段。以下类型供参考，不是穷尽分类，实际以对话真实语气为准：
• 日常/平淡场景：普通闲聊、日常活动，情绪平和。画面自然克制，不需要任何暧昧或视觉张力元素，重点是还原真实的生活状态。
• 情绪升温/关系靠近：语气变暖、有轻微调情或情感拉近，但没有明确身体暗示。画面可带一点若有若无的柔和氛围，幅度很小。
• 强烈暧昧/临界状态：对话已明确进入撩人、身体接触暗示、亲密行为语境。画面可以大胆呈现擦边、诱惑与张力，把遐想空间拉满。
• 负面/紧张情绪（冲突、难过、疲惫、压力等）：画面必须服务于情绪本身，可以压抑、疏离、沉重，绝对不能强行加入性张力或美化元素，这会显得违和且冒犯。
• 特定行动场景（运动、工作、探险、日常任务等）：画面服务于动作本身的力度和真实感，不需要任何暗示性处理，重点在动作是否可信、场景是否合理。
判断的唯一依据是对话中呈现出的真实语气、动作走向和情绪状态，不能凭空拔高或降低尺度。
---
第二步：角色形象的处理方式（关键）
【角色基础形象设定】中包含两类信息，处理方式完全不同：
1. 核心识别特征（不可变，必须逐字保留）调用该角色{character_persona_and_style} 字段
此字段为固定调用用于锚定角色核心特征如发色，瞳孔脸型，身高等，不可更改
2. 可变呈现状态（随场景自由生成，不需要参照默认设定）包括发型是否整齐凌乱、妆感、配饰佩戴与否、表情神态、姿态动作、当下穿着。这部分完全由【最近对话上下文】里的实际情境决定，不受角色基础形象设定里任何默认描述的约束——如果对话暗示头发凌乱、衣着不整，就按对话来写，不需要保持"整齐"这种默认状态。如果对话完全没有提供任何相关线索，可参考【角色基础形象设定】中的默认风格作兜底，避免画面空洞。
融合原则：把第1类的核心特征，自然地编织进当前场景的动作和神态描写中（分布式嵌入，而不是集中堆砌在开头），第2类的呈现状态完全根据对话情境自由生成。整段读起来应该是一段连贯流畅的场景描写，而不是"人设卡朗读+场景卡朗读"的拼接感。
---
第三步：依据阶段判断结果撰写场景与镜头语言
• 【高颜值铁律·始终生效】 无论判断出什么阶段、无论角色是男是女（含伪娘、机械人等特殊设定），画面主体必须是好看的——五官精致、面容美型、气质出众、颜值高。这是产品的核心卖点，不随阶段浮动。负面/压抑场景下，是"好看的人在承受情绪"，光影可以压抑，但人物本身绝不能丑；伪娘类角色尤其要美型，禁止画成普通男性脸。
• 【非主角/NPC 兜底】 当画面里出现【角色基础形象设定】未覆盖的角色（NPC、路人、次要角色）时，不要因为没有其具体外貌字段就画糊画丑——默认赋予「基本高颜值」：五官精致、面容美型、颜值高。主角与所有非主角角色都必须好看。
• 镜头语言与光影的"精致程度"要跟随阶段浮动，不是每次都用最高强度的电影级描写。日常场景可以用轻松自然的构图和光线，不需要堆砌"电影级质感、浅景深、胶片颗粒"这类词汇；只有当阶段本身确实需要氛围渲染（比如强烈暧昧或情绪浓烈的场景）时，才动用更讲究的镜头语言去强化它。
• 是否包含暗示性描写完全取决于阶段判断。如果当前对话没有任何暧昧成分，就不要主动添加咬唇、湿发、衣物松垮之类的暗示元素——这类描写只在判断结果确实指向亲密/暧昧阶段时才使用，当内容明确提及色情内容与场景，则需要直接进行相应拆解输出
• 核心检验标准：这张图放在这段对话后面，用户会不会觉得"违和"或"用力过猛"。如果会，说明画面强度和阶段没对上，需要往回收。
• 最终提示词必须体现【写实生成风格】所指定的画面风格，风格关键词应该自然融入镜头语言描述中
---
输出格式
直接输出最终的中文图像生成提示词本身，不要输出阶段判断过程、分析或任何解释性文字。要求语法完整、画面感强、是自然流畅的一段连贯描写（不是分段罗列，也不是关键词堆砌），角色核心识别特征与当前场景动作要读起来像同一段描写自然带出，句子的精致程度跟随阶段浮动，不必每次都追求视觉炫技。
---
输入信息格式

$image_description_system_prompt$
)
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE
  v_table REGCLASS;
  v_constraint_name TEXT;
  v_existing_expression TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'admin.config_drafts'::REGCLASS,
    'admin.config_releases'::REGCLASS
  ] LOOP
    v_constraint_name := CASE v_table
      WHEN 'admin.config_drafts'::REGCLASS THEN 'config_drafts_config_key_check'
      ELSE 'config_releases_config_key_check'
    END;

    SELECT pg_get_expr(c.conbin, c.conrelid)
      INTO v_existing_expression
    FROM pg_constraint c
    WHERE c.conrelid = v_table
      AND c.conname = v_constraint_name
      AND c.contype = 'c';

    IF v_existing_expression IS NULL THEN
      RAISE EXCEPTION 'missing expected constraint %.%', v_table, v_constraint_name;
    END IF;

    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_table, v_constraint_name);
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I CHECK ((%s) OR config_key = %L)',
      v_table,
      v_constraint_name,
      v_existing_expression,
      'image_description_system_prompt'
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION admin.is_managed_config_key(p_config_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT p_config_key IN (
    'miniapp_new_user_signup_bonus_credits', 'miniapp_daily_checkin_bonus_credits',
    'miniapp_character_free_chat_quota_limit', 'miniapp_payment_plans',
    'miniapp_recharge_page_config', 'miniapp_payment_prompt_dialog_config',
    'miniapp_free_quota_exhausted_dialog_config', 'llm_model_catalog', 'llm_pricing_config',
    'system_fallback_character_id', 'system_instructions', 'pref_word_count_tiers',
    'lobby_ranking_params', 'lobby_pinned_characters', 'miniapp_invite_reward_rules',
    'miniapp_invite_center_config', 'miniapp_invite_entry_enabled',
    'image_generation_enabled', 'image_generation_credits', 'image_price_label',
    'image_default_art_style', 'image_description_system_prompt', 'image_width',
    'image_height', 'image_max_prompt_chars', 'image_max_output_bytes',
    'image_prompt_policy', 'image_prompt_over_limit_hint', 'image_description_failed_hint',
    'image_generation_failed_hint', 'image_failed_unknown_hint', 'image_text_model_config'
  );
$$;

CREATE OR REPLACE FUNCTION admin.validate_managed_config_value(
  p_config_key TEXT,
  p_value JSONB,
  p_text_value TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_config_key = 'image_description_system_prompt' THEN
    IF p_value IS NOT NULL THEN
      RAISE EXCEPTION 'image_description_system_prompt must store text in text_value'
        USING ERRCODE = '22023';
    END IF;
    IF p_text_value IS NULL OR char_length(trim(p_text_value)) = 0 THEN
      RAISE EXCEPTION 'image_description_system_prompt text_value must be nonempty'
        USING ERRCODE = '22023';
    END IF;
    IF char_length(p_text_value) > 12000 THEN
      RAISE EXCEPTION 'image_description_system_prompt is too long'
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key = 'image_text_model_config' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'image_text_model_config must not use text_value' USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_image_text_model_config(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'lobby_pinned_characters' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'lobby_pinned_characters must not use text_value' USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_lobby_pinned_characters(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'miniapp_payment_prompt_dialog_config' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_payment_prompt_dialog_config must not use text_value' USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_payment_prompt_dialog_config(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'miniapp_invite_reward_rules' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_invite_reward_rules must not use text_value' USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_invite_reward_rules(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'miniapp_invite_center_config' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_invite_center_config must not use text_value' USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_invite_center_config(p_value);
    RETURN;
  END IF;
  IF p_config_key = 'miniapp_invite_entry_enabled' THEN
    IF p_text_value IS NOT NULL OR jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'miniapp_invite_entry_enabled must be a JSON boolean' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  IF p_config_key IN (
    'image_generation_enabled', 'image_generation_credits', 'image_price_label',
    'image_default_art_style', 'image_width', 'image_height', 'image_max_prompt_chars',
    'image_max_output_bytes', 'image_prompt_policy', 'image_prompt_over_limit_hint',
    'image_description_failed_hint', 'image_generation_failed_hint', 'image_failed_unknown_hint'
  ) THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION '% must not use text_value', p_config_key USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_image_generation_config_value(p_config_key, p_value);
    RETURN;
  END IF;
  PERFORM admin.validate_managed_config_value_before_payment_prompt(
    p_config_key, p_value, p_text_value
  );
END;
$$;

REVOKE ALL ON FUNCTION admin.is_managed_config_key(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  v_table REGCLASS;
  v_constraint_name TEXT;
  v_definition TEXT;
  v_raised BOOLEAN := FALSE;
BEGIN
  IF (SELECT text_value FROM app_core.runtime_config WHERE key = 'image_description_system_prompt') IS NULL THEN
    RAISE EXCEPTION 'self-check failed: image_description_system_prompt runtime text missing';
  END IF;

  FOREACH v_table IN ARRAY ARRAY[
    'admin.config_drafts'::REGCLASS,
    'admin.config_releases'::REGCLASS
  ] LOOP
    v_constraint_name := CASE v_table
      WHEN 'admin.config_drafts'::REGCLASS THEN 'config_drafts_config_key_check'
      ELSE 'config_releases_config_key_check'
    END;

    SELECT pg_get_constraintdef(c.oid)
      INTO v_definition
    FROM pg_constraint c
    WHERE c.conrelid = v_table
      AND c.conname = v_constraint_name
      AND c.contype = 'c';

    IF v_definition IS NULL OR position('image_description_system_prompt' IN v_definition) = 0 THEN
      RAISE EXCEPTION 'self-check failed: %.% missing image_description_system_prompt',
        v_table, v_constraint_name;
    END IF;
  END LOOP;

  IF NOT admin.is_managed_config_key('image_description_system_prompt') THEN
    RAISE EXCEPTION 'self-check failed: image_description_system_prompt is not managed';
  END IF;

  PERFORM admin.validate_managed_config_value(
    'image_description_system_prompt',
    NULL,
    'valid prompt'
  );
  BEGIN
    PERFORM admin.validate_managed_config_value(
      'image_description_system_prompt',
      '"invalid"'::JSONB,
      'valid prompt'
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_raised := TRUE;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'self-check failed: image_description_system_prompt accepted JSON value';
  END IF;
END;
$$;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- 执行后验证：
-- SELECT key, value, char_length(text_value), version
-- FROM app_core.runtime_config
-- WHERE key = 'image_description_system_prompt';
-- SELECT admin.is_managed_config_key('image_description_system_prompt'); -- true
