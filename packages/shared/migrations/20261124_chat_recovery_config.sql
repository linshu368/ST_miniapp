-- Domain: admin（运营托管配置：登记 + 写入校验）
-- 设计：.trellis/tasks/11-24-chat-recovery/design.md（§7 配置）。
--
-- 出字后兜底的托管配置 chat_recovery_config（用户 11-24 定）：
--   1. admin.managed_config_keys 登记 chat_recovery_config（JSON，存 runtime_config.value）；
--   2. admin.validate_managed_config_value 原地加一个 WHEN 分支：只收 JSON 对象，恰好
--      fallback_first_token_ms（1000–20000）、interruption{enabled, stall_ms 1000–60000}、
--      refusal{enabled, check_chars 5–200, keywords 最多 500 个、每个去空白后 1–40 字}。
--      分三段 IF 依次判（先判类型再取值），不会因类型不对抛出非 22023 的错误。
--      整数、字符集等细则由 shared ChatRecoveryConfigSchema（运营平台保存时）和后端读取时再校验。
--      读现行定义，在 status_memory_model_config 分支前插入，锚点必须恰好一处，对不上就拒绝执行；已加过的跳过。
-- 迁移不写配置值：没配时后端按两个开关关闭处理，首版由运营平台 CLI 发布。
--
-- 执行：TEST → 生产。无锁表、无数据变更；先于或晚于后端发布都可以。
-- 验证：bash scripts/test-chat-recovery-config-migration.sh
-- 回滚：UPDATE admin.managed_config_keys SET retired_at = now() WHERE config_key = 'chat_recovery_config';
--       分支留着无害；如需删分支，按 git 历史反向替换。
BEGIN;
SET LOCAL lock_timeout = '5s';

INSERT INTO admin.managed_config_keys (config_key, managed_via, note)
VALUES ('chat_recovery_config', 'operations_config', '出字后兜底：中断/拒答识别开关与阈值、拒答词池、兜底首字时限；擦掉重写')
ON CONFLICT (config_key) DO NOTHING;

DO $branch$
DECLARE
  v_proc constant regprocedure := 'admin.validate_managed_config_value(text,jsonb,text)'::regprocedure;
  v_anchor constant text := E'\n    WHEN ''status_memory_model_config'' THEN';
  v_error constant text :=
    E'\n        RAISE EXCEPTION ''chat_recovery_config requires fallback_first_token_ms, interruption{enabled, stall_ms}, refusal{enabled, check_chars, keywords}'''
    || E'\n          USING ERRCODE = ''22023'';';
  v_branch constant text := E'\n    WHEN ''chat_recovery_config'' THEN'
    || E'\n      IF p_text_value IS NOT NULL OR p_value IS NULL OR jsonb_typeof(p_value) <> ''object'''
    || E'\n         OR jsonb_typeof(p_value -> ''interruption'') IS DISTINCT FROM ''object'''
    || E'\n         OR jsonb_typeof(p_value -> ''refusal'') IS DISTINCT FROM ''object'' THEN'
    || v_error
    || E'\n      END IF;'
    || E'\n      IF (SELECT count(*) FROM jsonb_object_keys(p_value)) <> 3'
    || E'\n         OR (SELECT count(*) FROM jsonb_object_keys(p_value -> ''interruption'')) <> 2'
    || E'\n         OR (SELECT count(*) FROM jsonb_object_keys(p_value -> ''refusal'')) <> 3'
    || E'\n         OR jsonb_typeof(p_value -> ''fallback_first_token_ms'') IS DISTINCT FROM ''number'''
    || E'\n         OR jsonb_typeof(p_value #> ''{interruption,enabled}'') IS DISTINCT FROM ''boolean'''
    || E'\n         OR jsonb_typeof(p_value #> ''{interruption,stall_ms}'') IS DISTINCT FROM ''number'''
    || E'\n         OR jsonb_typeof(p_value #> ''{refusal,enabled}'') IS DISTINCT FROM ''boolean'''
    || E'\n         OR jsonb_typeof(p_value #> ''{refusal,check_chars}'') IS DISTINCT FROM ''number'''
    || E'\n         OR jsonb_typeof(p_value #> ''{refusal,keywords}'') IS DISTINCT FROM ''array'' THEN'
    || v_error
    || E'\n      END IF;'
    || E'\n      IF (p_value ->> ''fallback_first_token_ms'')::numeric NOT BETWEEN 1000 AND 20000'
    || E'\n         OR (p_value #>> ''{interruption,stall_ms}'')::numeric NOT BETWEEN 1000 AND 60000'
    || E'\n         OR (p_value #>> ''{refusal,check_chars}'')::numeric NOT BETWEEN 5 AND 200'
    || E'\n         OR jsonb_array_length(p_value #> ''{refusal,keywords}'') > 500'
    || E'\n         OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_value #> ''{refusal,keywords}'') AS k(item)'
    || E'\n                    WHERE jsonb_typeof(item) <> ''string'' OR length(btrim(item #>> ''{}'')) NOT BETWEEN 1 AND 40) THEN'
    || v_error
    || E'\n      END IF;'
    || E'\n';
  v_def text;
  v_hits integer;
BEGIN
  v_def := replace(pg_get_functiondef(v_proc), E'\r', '');
  IF position('''chat_recovery_config''' IN v_def) > 0 THEN
    RETURN;  -- 已加过（重跑）
  END IF;
  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'chat_recovery_config: expected exactly one status_memory_model_config branch, found %; refusing to rewrite', v_hits;
  END IF;
  -- replace() 按字面替换，避免 regexp_replace 把分支里的字符当成反向引用
  EXECUTE replace(v_def, v_anchor, v_branch || substr(v_anchor, 2));
END
$branch$;

-- 核对：合法值通过；文本、缺字段、多字段、类型不对、越界、空关键词都拒绝（且都是 22023）
DO $verify$
DECLARE
  v_ok constant jsonb := '{"fallback_first_token_ms": 3000, "interruption": {"enabled": false, "stall_ms": 3000}, "refusal": {"enabled": false, "check_chars": 30, "keywords": ["我不能写"]}}';
  v_bad jsonb[] := ARRAY[
    '{"interruption": {"enabled": false, "stall_ms": 3000}, "refusal": {"enabled": false, "check_chars": 30, "keywords": []}}',
    '{"fallback_first_token_ms": 3000, "interruption": {"enabled": false, "stall_ms": 3000}, "refusal": {"enabled": false, "check_chars": 30, "keywords": []}, "extra": 1}',
    '{"fallback_first_token_ms": "3000", "interruption": {"enabled": false, "stall_ms": 3000}, "refusal": {"enabled": false, "check_chars": 30, "keywords": []}}',
    '{"fallback_first_token_ms": 3000, "interruption": {"enabled": "yes", "stall_ms": 3000}, "refusal": {"enabled": false, "check_chars": 30, "keywords": []}}',
    '{"fallback_first_token_ms": 3000, "interruption": {"enabled": false, "stall_ms": 500}, "refusal": {"enabled": false, "check_chars": 30, "keywords": []}}',
    '{"fallback_first_token_ms": 3000, "interruption": {"enabled": false, "stall_ms": 3000}, "refusal": {"enabled": false, "check_chars": 30, "keywords": "我不能写"}}',
    '{"fallback_first_token_ms": 3000, "interruption": {"enabled": false, "stall_ms": 3000}, "refusal": {"enabled": false, "check_chars": 30, "keywords": ["  "]}}',
    '{"fallback_first_token_ms": 3000, "interruption": {"enabled": false, "stall_ms": 3000}, "refusal": {"enabled": false, "check_chars": 30, "keywords": [1]}}',
    '{"fallback_first_token_ms": 3000, "interruption": [], "refusal": {"enabled": false, "check_chars": 30, "keywords": []}}'
  ]::jsonb[];
  v_item jsonb;
BEGIN
  PERFORM admin.validate_managed_config_value('chat_recovery_config', v_ok, NULL);
  BEGIN
    PERFORM admin.validate_managed_config_value('chat_recovery_config', NULL, 'text');
    RAISE EXCEPTION 'chat_recovery_config: text value accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;
  FOREACH v_item IN ARRAY v_bad LOOP
    BEGIN
      PERFORM admin.validate_managed_config_value('chat_recovery_config', v_item, NULL);
      RAISE EXCEPTION 'chat_recovery_config: invalid value accepted: %', v_item;
    EXCEPTION WHEN sqlstate '22023' THEN NULL;
    END;
  END LOOP;
END
$verify$;

COMMIT;
