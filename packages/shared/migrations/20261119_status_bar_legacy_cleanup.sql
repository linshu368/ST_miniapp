-- Domain: experience（聊天记录的提示词槽位档位）+ admin（运营托管配置）
-- 设计：.trellis/tasks/11-19-custom-status-bar/design.md §6.11。
--
-- 状态栏 v2 上线后，正文模型不再输出状态栏（状态由独立模型记录、聊天页右侧状态面板展示）。
-- 本迁移清掉旧状态栏在库里的残留：
--   1. 两个开始轮次的函数不再写/返回 status_rules_mode；守卫触发器不再看这一列（各原地删一处，
--      照 20261118_db_reorg_p3c 的做法：读现行定义、只替换恰好一处，对不上就拒绝执行；已改过的跳过）；
--   2. 删 experience.chat_history.status_rules_mode 及其 CHECK（纯元数据操作，短暂排他锁）；
--   3. 配置校验不再要求主体模板带 {{STATUS_RULES}}，分发里去掉 status_rules；
--   4. 托管 key status_rules 退役（retired_at，发布历史仍引用所以保留行），删它的草稿与运行值。
--
-- 前置：后端已发布不再读取 status_rules_mode 的版本（旧版后端要求三档都在，否则本轮槽位档位为空）。
-- 执行顺序：TEST → 生产（需确认）；之后运营再发布去掉状态栏文字与占位的主体模板。
-- 回滚：列与数据不可恢复（只是每轮记录的"状态栏档位"，已无读者）；如需恢复函数，按 git 历史反向替换。
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $legacy$
DECLARE
  r record;
  v_def text;
  v_hits integer;
BEGIN
  FOR r IN
  SELECT * FROM (VALUES
    (1, 'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)',
     $p$\n[ \t]*status_rules_mode = CASE WHEN v_settings\.pref_show_status THEN v_mode ELSE 'off' END,$p$),
    (2, 'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)',
     $p$'status_rules_mode', status_rules_mode, $p$),
    (3, 'experience.start_chat_history_regeneration_with_current_postprocess(uuid,integer,text,integer,integer,integer)',
     $p$\n[ \t]*status_rules_mode = CASE WHEN v_settings\.pref_show_status THEN v_mode ELSE 'off' END,$p$),
    (4, 'experience.start_chat_history_regeneration_with_current_postprocess(uuid,integer,text,integer,integer,integer)',
     $p$'status_rules_mode', status_rules_mode, $p$),
    (5, 'experience.guard_chat_history_instruction_slot_modes()',
     $p$\n[ \t]*AND NEW\.status_rules_mode IS NULL$p$),
    (6, 'experience.guard_chat_history_instruction_slot_modes()',
     $p$\n[ \t]*AND NEW\.status_rules_mode IS NOT DISTINCT FROM OLD\.status_rules_mode$p$),
    (7, 'admin.validate_managed_config_value(text,jsonb,text)',
     $p$'\{\{STATUS_RULES\}\}', $p$),
    (8, 'admin.validate_managed_config_value(text,jsonb,text)',
     $p$'status_rules', $p$)
  ) AS t(step, fn, pattern)
  ORDER BY step
  LOOP
    v_def := replace(pg_get_functiondef(to_regprocedure(r.fn)), E'\r', '');
    SELECT count(*) INTO v_hits FROM regexp_matches(v_def, r.pattern, 'g');
    IF v_hits = 0 THEN
      CONTINUE;  -- 已改（重跑）
    END IF;
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '% step %: expected exactly one match, found %; refusing to rewrite', r.fn, r.step, v_hits;
    END IF;
    EXECUTE regexp_replace(v_def, r.pattern, '');
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid IN (
      'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)'::regprocedure,
      'experience.start_chat_history_regeneration_with_current_postprocess(uuid,integer,text,integer,integer,integer)'::regprocedure,
      'experience.guard_chat_history_instruction_slot_modes()'::regprocedure)
      AND position('status_rules' IN prosrc) > 0
  ) OR position('STATUS_RULES' IN pg_get_functiondef('admin.validate_managed_config_value(text,jsonb,text)'::regprocedure)) > 0
    OR position('''status_rules''' IN pg_get_functiondef('admin.validate_managed_config_value(text,jsonb,text)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'status bar legacy cleanup: functions still reference the status slot';
  END IF;
END
$legacy$;

ALTER TABLE experience.chat_history
  DROP CONSTRAINT IF EXISTS chat_history_status_rules_mode_check,
  DROP COLUMN IF EXISTS status_rules_mode;

UPDATE admin.managed_config_keys
SET retired_at = now(),
    note = '状态栏 v2：正文模型不再输出状态栏，状态由独立模型记录（20261119_status_bar_legacy_cleanup）'
WHERE config_key = 'status_rules' AND retired_at IS NULL;
DELETE FROM admin.config_drafts WHERE config_key = 'status_rules';
DELETE FROM app_core.runtime_config WHERE key = 'status_rules';

COMMIT;
