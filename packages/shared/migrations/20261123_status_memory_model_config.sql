-- Domain: admin（运营托管配置：登记 + 写入校验）
-- 设计：.trellis/tasks/11-23-memory-panel/task.md（T12）。
--
-- 状态栏、记忆栏共用的模型放运营平台（用户 11-23 定：首发、兜底两个模型都能在平台上换）：
--   1. admin.managed_config_keys 登记 status_memory_model_config（JSON，存 runtime_config.value）；
--   2. admin.validate_managed_config_value 原地加一个 WHEN 分支：只收 JSON 对象，恰好 primary_model、
--      fallback_model 两个字符串键，去空白后 1–200 字。字符集等细则由 shared StatusMemoryModelConfigSchema
--      （运营平台保存时）和后端读取时再校验，同 story_memory_config 的做法。
--      读现行定义，在 story_memory_config 分支前插入，锚点必须恰好一处，对不上就拒绝执行；已加过的跳过。
-- 迁移不写配置值：没配时后端用默认模型（Gemini 3 Flash + deepseek/deepseek-v4-flash），首版由运营平台 CLI 发布。
--
-- 执行：TEST → 生产（需确认）。无锁表、无数据变更；先于或晚于后端发布都可以（后端读不到就用默认）。
-- 回滚：UPDATE admin.managed_config_keys SET retired_at = now() WHERE config_key = 'status_memory_model_config';
--       分支留着无害；如需删分支，按 git 历史反向替换。
BEGIN;
SET LOCAL lock_timeout = '5s';

INSERT INTO admin.managed_config_keys (config_key, managed_via, note)
VALUES ('status_memory_model_config', 'operations_config', '状态栏/记忆栏模型：首发（Surplus）与兜底（OpenRouter）模型名；通道与参数由代码固定')
ON CONFLICT (config_key) DO NOTHING;

DO $branch$
DECLARE
  v_proc constant regprocedure := 'admin.validate_managed_config_value(text,jsonb,text)'::regprocedure;
  v_anchor constant text := E'\n    WHEN ''story_memory_config'' THEN';
  v_branch constant text := E'\n    WHEN ''status_memory_model_config'' THEN'
    || E'\n      IF p_text_value IS NOT NULL OR p_value IS NULL OR jsonb_typeof(p_value) <> ''object'''
    || E'\n         OR (SELECT count(*) FROM jsonb_object_keys(p_value)) <> 2'
    || E'\n         OR jsonb_typeof(p_value -> ''primary_model'') IS DISTINCT FROM ''string'''
    || E'\n         OR jsonb_typeof(p_value -> ''fallback_model'') IS DISTINCT FROM ''string'''
    || E'\n         OR length(btrim(p_value ->> ''primary_model'')) NOT BETWEEN 1 AND 200'
    || E'\n         OR length(btrim(p_value ->> ''fallback_model'')) NOT BETWEEN 1 AND 200 THEN'
    || E'\n        RAISE EXCEPTION ''status memory model config requires primary_model and fallback_model, 1-200 characters each'''
    || E'\n          USING ERRCODE = ''22023'';'
    || E'\n      END IF;'
    || E'\n';
  v_def text;
  v_hits integer;
BEGIN
  v_def := replace(pg_get_functiondef(v_proc), E'\r', '');
  IF position('''status_memory_model_config''' IN v_def) > 0 THEN
    RETURN;  -- 已加过（重跑）
  END IF;
  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'status_memory_model_config: expected exactly one story_memory_config branch, found %; refusing to rewrite', v_hits;
  END IF;
  -- replace() 按字面替换，避免 regexp_replace 把分支里的字符当成反向引用
  EXECUTE replace(v_def, v_anchor, v_branch || substr(v_anchor, 2));
END
$branch$;

-- 核对：合法值通过；文本、缺字段、多字段、空模型名都拒绝
DO $verify$
BEGIN
  PERFORM admin.validate_managed_config_value(
    'status_memory_model_config',
    '{"primary_model": "gemini-3-flash-preview", "fallback_model": "deepseek/deepseek-v4-flash"}'::jsonb,
    NULL);
  BEGIN
    PERFORM admin.validate_managed_config_value('status_memory_model_config', NULL, 'gemini-3-flash-preview');
    RAISE EXCEPTION 'status_memory_model_config: text value accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;
  BEGIN
    PERFORM admin.validate_managed_config_value('status_memory_model_config', '{"primary_model": "a"}'::jsonb, NULL);
    RAISE EXCEPTION 'status_memory_model_config: missing fallback_model accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;
  BEGIN
    PERFORM admin.validate_managed_config_value('status_memory_model_config',
      '{"primary_model": "a", "fallback_model": "b", "extra": 1}'::jsonb, NULL);
    RAISE EXCEPTION 'status_memory_model_config: extra key accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;
  BEGIN
    PERFORM admin.validate_managed_config_value('status_memory_model_config',
      '{"primary_model": "  ", "fallback_model": "b"}'::jsonb, NULL);
    RAISE EXCEPTION 'status_memory_model_config: blank model accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;
END
$verify$;

COMMIT;
