-- Domain: admin（运营托管配置：写入校验）
--
-- status_memory_model_config 增加可选键 fallback_provider（兜底来源：openrouter / surplus，不写按 openrouter）。
-- 用户 11-27 定：状态栏、记忆栏兜底改走 Surplus deepseek-v4.1-flash-1017，供应商设置跟畅聊兜底一致。
-- 20261125 的写入校验只放行 primary_model / memory_primary_model / fallback_model 三个键，带新键的配置会被拒绝。
-- 本迁移把该分支原地换成：多放行 fallback_provider，且它必须是 'openrouter' 或 'surplus'。
-- 读现行定义，旧分支必须恰好一处，对不上就拒绝执行；已换过的跳过。
--
-- 执行：TEST → 生产（需确认）。无锁表、无数据变更。必须先于「发布带 fallback_provider 的配置」执行；
--   后端要先上线（schema 是 strict，旧后端读到新键会整份判配坏、退回默认模型）。
-- 回滚：先把配置里的 fallback_provider 去掉并发布，再用本文件反向替换（v_new → v_old）重建函数。
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $branch$
DECLARE
  v_proc constant regprocedure := 'admin.validate_managed_config_value(text,jsonb,text)'::regprocedure;
  v_old constant text := E'\n    WHEN ''status_memory_model_config'' THEN'
    || E'\n      IF p_text_value IS NOT NULL OR p_value IS NULL OR jsonb_typeof(p_value) <> ''object'''
    || E'\n         OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_value) AS k(key)'
    || E'\n                    WHERE k.key NOT IN (''primary_model'', ''memory_primary_model'', ''fallback_model''))'
    || E'\n         OR jsonb_typeof(p_value -> ''primary_model'') IS DISTINCT FROM ''string'''
    || E'\n         OR jsonb_typeof(p_value -> ''fallback_model'') IS DISTINCT FROM ''string'''
    || E'\n         OR length(btrim(p_value ->> ''primary_model'')) NOT BETWEEN 1 AND 200'
    || E'\n         OR length(btrim(p_value ->> ''fallback_model'')) NOT BETWEEN 1 AND 200'
    || E'\n         OR (p_value ? ''memory_primary_model'' AND ('
    || E'\n              jsonb_typeof(p_value -> ''memory_primary_model'') IS DISTINCT FROM ''string'''
    || E'\n              OR length(btrim(p_value ->> ''memory_primary_model'')) NOT BETWEEN 1 AND 200)) THEN'
    || E'\n        RAISE EXCEPTION ''status memory model config requires primary_model and fallback_model (memory_primary_model optional), 1-200 characters each'''
    || E'\n          USING ERRCODE = ''22023'';'
    || E'\n      END IF;'
    || E'\n';
  v_new constant text := E'\n    WHEN ''status_memory_model_config'' THEN'
    || E'\n      IF p_text_value IS NOT NULL OR p_value IS NULL OR jsonb_typeof(p_value) <> ''object'''
    || E'\n         OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_value) AS k(key)'
    || E'\n                    WHERE k.key NOT IN (''primary_model'', ''memory_primary_model'', ''fallback_model'', ''fallback_provider''))'
    || E'\n         OR jsonb_typeof(p_value -> ''primary_model'') IS DISTINCT FROM ''string'''
    || E'\n         OR jsonb_typeof(p_value -> ''fallback_model'') IS DISTINCT FROM ''string'''
    || E'\n         OR length(btrim(p_value ->> ''primary_model'')) NOT BETWEEN 1 AND 200'
    || E'\n         OR length(btrim(p_value ->> ''fallback_model'')) NOT BETWEEN 1 AND 200'
    || E'\n         OR (p_value ? ''memory_primary_model'' AND ('
    || E'\n              jsonb_typeof(p_value -> ''memory_primary_model'') IS DISTINCT FROM ''string'''
    || E'\n              OR length(btrim(p_value ->> ''memory_primary_model'')) NOT BETWEEN 1 AND 200))'
    || E'\n         OR (p_value ? ''fallback_provider'' AND ('
    || E'\n              jsonb_typeof(p_value -> ''fallback_provider'') IS DISTINCT FROM ''string'''
    || E'\n              OR (p_value ->> ''fallback_provider'') NOT IN (''openrouter'', ''surplus''))) THEN'
    || E'\n        RAISE EXCEPTION ''status memory model config requires primary_model and fallback_model (memory_primary_model optional), 1-200 characters each; fallback_provider optional: openrouter or surplus'''
    || E'\n          USING ERRCODE = ''22023'';'
    || E'\n      END IF;'
    || E'\n';
  v_def text;
  v_hits integer;
BEGIN
  v_def := replace(pg_get_functiondef(v_proc), E'\r', '');
  IF position('fallback_provider' IN v_def) > 0 THEN
    RETURN;  -- 已换过（重跑）
  END IF;
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'status_memory_model_config: expected exactly one original branch, found %; refusing to rewrite', v_hits;
  END IF;
  -- replace() 按字面替换，避免 regexp_replace 把分支里的字符当成反向引用
  EXECUTE replace(v_def, v_old, v_new);
END
$branch$;

-- 核对：老配置（无来源键）、两种来源通过；未知来源、非字符串来源、其他键、缺必填都拒绝
DO $verify$
BEGIN
  PERFORM admin.validate_managed_config_value('status_memory_model_config',
    '{"primary_model": "gemini-3-flash-preview", "fallback_model": "deepseek/deepseek-v4-flash"}'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value('status_memory_model_config',
    '{"primary_model": "gemini-3-flash-preview", "memory_primary_model": "deepseek-v4.1-flash-1017", "fallback_model": "deepseek-v4.1-flash-1017", "fallback_provider": "surplus"}'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value('status_memory_model_config',
    '{"primary_model": "a", "fallback_model": "b", "fallback_provider": "openrouter"}'::jsonb, NULL);
  BEGIN
    PERFORM admin.validate_managed_config_value('status_memory_model_config',
      '{"primary_model": "a", "fallback_model": "b", "fallback_provider": "packy"}'::jsonb, NULL);
    RAISE EXCEPTION 'status_memory_model_config: unknown fallback_provider accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;
  BEGIN
    PERFORM admin.validate_managed_config_value('status_memory_model_config',
      '{"primary_model": "a", "fallback_model": "b", "fallback_provider": 1}'::jsonb, NULL);
    RAISE EXCEPTION 'status_memory_model_config: non-string fallback_provider accepted';
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
      '{"fallback_model": "b", "fallback_provider": "surplus"}'::jsonb, NULL);
    RAISE EXCEPTION 'status_memory_model_config: missing primary_model accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;
END
$verify$;

COMMIT;
