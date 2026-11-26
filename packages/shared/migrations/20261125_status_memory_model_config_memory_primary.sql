-- Domain: admin（运营托管配置：写入校验）
-- 设计：.trellis/tasks/11-25-memory-bar-tight-target/prd.md
--
-- status_memory_model_config 增加可选键 memory_primary_model（记忆栏首发模型，不填沿用 primary_model；
-- 用户 11-25 定：记忆栏首发换 Surplus deepseek-v4.1-flash-1017，状态栏不跟着换）。
-- 20261123_status_memory_model_config.sql 的写入校验要求「恰好两个键」，带新键的配置会被拒绝。
-- 本迁移把该分支原地换成：primary_model、fallback_model 必填，memory_primary_model 可选，不允许其他键；
-- 每个模型名去空白后 1–200 字。字符集等细则仍由 shared StatusMemoryModelConfigSchema 校验。
-- 读现行定义，旧分支必须恰好一处，对不上就拒绝执行；已换过的跳过。
--
-- 执行：TEST → 生产（需确认）。无锁表、无数据变更。后端（PR #1180，已上线）已认识新键；
--   本迁移之后才能发布带 memory_primary_model 的配置。
-- 回滚：先把配置里的 memory_primary_model 去掉并发布，再用本文件反向替换（v_new → v_old）重建函数。
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $branch$
DECLARE
  v_proc constant regprocedure := 'admin.validate_managed_config_value(text,jsonb,text)'::regprocedure;
  v_old constant text := E'\n    WHEN ''status_memory_model_config'' THEN'
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
  v_new constant text := E'\n    WHEN ''status_memory_model_config'' THEN'
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
  v_def text;
  v_hits integer;
BEGIN
  v_def := replace(pg_get_functiondef(v_proc), E'\r', '');
  IF position('memory_primary_model' IN v_def) > 0 THEN
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

-- 核对：两个键、带记忆栏首发的三个键通过；其他键、空/非字符串的记忆栏首发、缺必填都拒绝
DO $verify$
BEGIN
  PERFORM admin.validate_managed_config_value(
    'status_memory_model_config',
    '{"primary_model": "gemini-3-flash-preview", "fallback_model": "deepseek/deepseek-v4-flash"}'::jsonb,
    NULL);
  PERFORM admin.validate_managed_config_value(
    'status_memory_model_config',
    '{"primary_model": "gemini-3-flash-preview", "memory_primary_model": "deepseek-v4.1-flash-1017", "fallback_model": "deepseek/deepseek-v4-flash"}'::jsonb,
    NULL);
  BEGIN
    PERFORM admin.validate_managed_config_value('status_memory_model_config',
      '{"primary_model": "a", "fallback_model": "b", "extra": 1}'::jsonb, NULL);
    RAISE EXCEPTION 'status_memory_model_config: extra key accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;
  BEGIN
    PERFORM admin.validate_managed_config_value('status_memory_model_config',
      '{"primary_model": "a", "memory_primary_model": "  ", "fallback_model": "b"}'::jsonb, NULL);
    RAISE EXCEPTION 'status_memory_model_config: blank memory_primary_model accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;
  BEGIN
    PERFORM admin.validate_managed_config_value('status_memory_model_config',
      '{"primary_model": "a", "memory_primary_model": 1, "fallback_model": "b"}'::jsonb, NULL);
    RAISE EXCEPTION 'status_memory_model_config: non-string memory_primary_model accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;
  BEGIN
    PERFORM admin.validate_managed_config_value('status_memory_model_config',
      '{"memory_primary_model": "a", "fallback_model": "b"}'::jsonb, NULL);
    RAISE EXCEPTION 'status_memory_model_config: missing primary_model accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;
  BEGIN
    PERFORM admin.validate_managed_config_value('status_memory_model_config', NULL, 'gemini-3-flash-preview');
    RAISE EXCEPTION 'status_memory_model_config: text value accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;
END
$verify$;

COMMIT;
