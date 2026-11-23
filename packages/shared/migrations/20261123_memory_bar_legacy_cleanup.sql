-- Domain: experience（聊天记录的提示词槽位档位）+ admin（运营托管配置）
-- 设计：.trellis/tasks/11-23-memory-panel/design.md；做法照 20261119_status_bar_legacy_cleanup。
--
-- 记忆栏拆出正文模型（#1080）后，正文模型只写剧情正文和选项，记忆由独立模型记录、聊天页右侧面板展示。
-- 本迁移清掉旧记忆区在库里的残留：
--   1. 两个开始轮次的函数不再写/返回 memory_rules_mode；守卫函数不再看这一列（函数各原地删一处，
--      读现行定义、只替换恰好一处，对不上就拒绝执行；已改过的跳过）；
--   2. 守卫触发器只看选项一列；删 experience.chat_history.memory_rules_mode 及其 CHECK（纯元数据操作，短暂排他锁）；
--   3. 配置校验的分发里去掉 memory_rules；
--   4. 托管 key memory_rules 退役（retired_at，发布历史仍引用所以保留行），删它没发布过的草稿与运行值。
-- 记忆栏开关 pref_show_memory 不动：新记忆栏仍按它决定是否记录。
--
-- 前置：后端已发布不再读取 memory_rules_mode / memory_rules 的版本（旧版后端要求两档都在，否则本轮槽位档位为空）。
-- 执行顺序：TEST → 生产（需确认）。
-- 回滚：列与数据不可恢复（只是每轮记录的"记忆区档位"，已无读者）；如需恢复函数，按 git 历史反向替换。
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
     $p$,\n[ \t]*memory_rules_mode = CASE WHEN v_settings\.pref_show_memory THEN v_mode ELSE 'off' END$p$, ''),
    (2, 'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)',
     $p$, 'memory_rules_mode', memory_rules_mode$p$, ''),
    (3, 'experience.start_chat_history_regeneration_with_current_postprocess(uuid,integer,text,integer,integer,integer)',
     $p$,\n[ \t]*memory_rules_mode = CASE WHEN v_settings\.pref_show_memory THEN v_mode ELSE 'off' END$p$, ''),
    (4, 'experience.start_chat_history_regeneration_with_current_postprocess(uuid,integer,text,integer,integer,integer)',
     $p$, 'memory_rules_mode', memory_rules_mode$p$, ''),
    (5, 'experience.guard_chat_history_instruction_slot_modes()',
     $p$\n[ \t]*AND NEW\.memory_rules_mode IS NULL$p$, ''),
    (6, 'experience.guard_chat_history_instruction_slot_modes()',
     $p$\n[ \t]*AND NEW\.memory_rules_mode IS NOT DISTINCT FROM OLD\.memory_rules_mode$p$, ''),
    (7, 'admin.validate_managed_config_value(text,jsonb,text)',
     $p$WHEN 'choice_rules', 'memory_rules' THEN$p$, $p$WHEN 'choice_rules' THEN$p$)
  ) AS t(step, fn, pattern, replacement)
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
    EXECUTE regexp_replace(v_def, r.pattern, r.replacement);
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid IN (
      'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)'::regprocedure,
      'experience.start_chat_history_regeneration_with_current_postprocess(uuid,integer,text,integer,integer,integer)'::regprocedure,
      'experience.guard_chat_history_instruction_slot_modes()'::regprocedure)
      AND position('memory_rules' IN prosrc) > 0
  ) OR position('''memory_rules''' IN pg_get_functiondef('admin.validate_managed_config_value(text,jsonb,text)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'memory bar legacy cleanup: functions still reference the memory slot';
  END IF;
END
$legacy$;

-- 守卫触发器是按列声明的（UPDATE OF 两列），依赖这一列：先改成只看选项一列再删列。
DROP TRIGGER IF EXISTS trg_guard_chat_history_instruction_slot_modes ON experience.chat_history;
CREATE TRIGGER trg_guard_chat_history_instruction_slot_modes
  BEFORE INSERT OR UPDATE OF choice_rules_mode ON experience.chat_history
  FOR EACH ROW EXECUTE FUNCTION experience.guard_chat_history_instruction_slot_modes();

ALTER TABLE experience.chat_history
  DROP CONSTRAINT IF EXISTS chat_history_memory_rules_mode_check,
  DROP COLUMN IF EXISTS memory_rules_mode;

UPDATE admin.managed_config_keys
SET retired_at = now(),
    note = '记忆栏拆出正文：正文模型不再输出记忆区，记忆由独立模型记录（20261123_memory_bar_legacy_cleanup）'
WHERE config_key = 'memory_rules' AND retired_at IS NULL;
-- 发布过的草稿被发布历史引用（source_draft_id），保留；只删没发布过的。
DELETE FROM admin.config_drafts AS d
WHERE d.config_key = 'memory_rules'
  AND NOT EXISTS (SELECT 1 FROM admin.config_releases AS r WHERE r.source_draft_id = d.id);
DELETE FROM app_core.runtime_config WHERE key = 'memory_rules';

-- 收尾核对：两个开始轮次的函数只返回选项档位；列已删。
DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'experience' AND table_name = 'chat_history' AND column_name = 'memory_rules_mode'
  ) THEN
    RAISE EXCEPTION 'memory bar legacy cleanup: memory_rules_mode still exists';
  END IF;
  IF position('choice_rules_mode' IN pg_get_functiondef(
       'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'memory bar legacy cleanup: start function lost choice_rules_mode';
  END IF;
END
$verify$;

COMMIT;
