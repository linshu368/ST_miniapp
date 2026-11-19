-- Domain: admin（运营托管配置的写入校验）
-- 状态栏改由独立模型记录、记忆栏下线：正文模型不再输出这两个模块，后端渲染时把旧占位替换为空。
-- 主体模板（system_instructions）不再必须包含 {{STATUS_RULES}}、{{MEMORY_RULES}}，运营可以直接删掉这两行。
-- 做法照 20261118_db_reorg_p3c：读现行定义，各只替换恰好一处，对不上就拒绝执行；已改过的跳过。
-- 其他必填占位（{{CHOICE_RULES}}、{{WORD_COUNT}}、{{USER_CUSTOM_INSTRUCTIONS}}）不变。
-- 执行：TEST → 生产（需确认）。无锁表、无数据变更。
-- 回滚：把两个占位加回必填列表（按 git 历史反向替换）；已发布的不含占位的模板不受影响（只在保存/发布时校验）。
BEGIN;

DO $optional$
DECLARE
  r record;
  v_def text;
  v_hits integer;
BEGIN
  FOR r IN
  SELECT * FROM (VALUES
    (1, $p$'\{\{STATUS_RULES\}\}',\s*$p$),
    (2, $p$'\{\{MEMORY_RULES\}\}',\s*$p$)
  ) AS t(step, pattern)
  ORDER BY step
  LOOP
    v_def := replace(pg_get_functiondef('admin.validate_managed_config_value(text,jsonb,text)'::regprocedure), E'\r', '');
    SELECT count(*) INTO v_hits FROM regexp_matches(v_def, r.pattern, 'g');
    IF v_hits = 0 THEN
      CONTINUE;  -- 已改（重跑）
    END IF;
    IF v_hits <> 1 THEN
      RAISE EXCEPTION 'step %: expected exactly one match, found %; refusing to rewrite', r.step, v_hits;
    END IF;
    EXECUTE regexp_replace(v_def, r.pattern, '');
  END LOOP;
  IF position('{{STATUS_RULES}}' IN pg_get_functiondef('admin.validate_managed_config_value(text,jsonb,text)'::regprocedure)) > 0
     OR position('{{MEMORY_RULES}}' IN pg_get_functiondef('admin.validate_managed_config_value(text,jsonb,text)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'placeholders still required';
  END IF;
END
$optional$;

COMMIT;
