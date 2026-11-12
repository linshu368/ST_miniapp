-- 20261112_rebind_text_postprocess_v19.sql
-- domain: experience（只改 chat_history.postprocess_version，不碰正文）
--
-- 背景：回复富文本规则 v18（2026-11-05）删掉了 choice / status / memory / dialogue 四条规则。
-- 这四条的正则早已停用，但内置选项/状态栏/记忆卡片和对白的样式写在它们的 css 里，
-- 渲染器对停用规则照样输出 css。删除后，绑定 v18 的回复只剩基础样式。
-- 2026-11-12 已在运营平台把规则回滚到 v17，生成 v19（快照与 v17 完全一致）。
--
-- 本迁移把绑定 v18 的历史回复改绑到 v19，用户刷新后历史回复也恢复原样式。
-- 保护条件：v19 快照与 v17 完全相同，且 v18 确实缺少 choice 规则；否则整体跳过
-- （例如 TEST 的规则版本号与生产不同），不报错。
-- 写入许可：postprocess_version 受 trg_guard_chat_history_postprocess_version 保护，
-- 需在同一事务内先调用 experience.text_postprocess_bind_enter()（仅函数属主 postgres 可用）。
-- 不准备回滚：v18 与 v19 的差别只有这四条样式规则。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  v_rows integer;
BEGIN
  IF to_regprocedure('experience.text_postprocess_bind_enter()') IS NULL THEN
    RAISE EXCEPTION '20261112_rebind_text_postprocess_v19: experience.text_postprocess_bind_enter() is missing';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM app_core.text_postprocess_versions AS v19
       JOIN app_core.text_postprocess_versions AS v17 ON v17.version = 17
       WHERE v19.version = 19 AND v19.artifact = v17.artifact
     )
     OR NOT EXISTS (
       SELECT 1
       FROM app_core.text_postprocess_versions
       WHERE version = 18
         AND NOT ((artifact -> 'rules') @> '[{"id": "choice"}]'::jsonb)
     ) THEN
    RAISE NOTICE '20261112_rebind_text_postprocess_v19: v17/v18/v19 do not match the production incident, skipped';
    RETURN;
  END IF;

  PERFORM experience.text_postprocess_bind_enter();
  UPDATE experience.chat_history
  SET postprocess_version = 19
  WHERE postprocess_version = 18;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE '20261112_rebind_text_postprocess_v19: rebound % rows from v18 to v19', v_rows;
END;
$$;

COMMIT;
