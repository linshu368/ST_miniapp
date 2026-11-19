-- Domain: experience（对话轮次 chat_history）——数据库重组阶段 5b 第二步：删 history 列。
-- 计划见 .trellis/tasks/11-19-db-reorg-p5-chat-history/design.md（5b）。
--
-- 前提（第一步 20261119_db_reorg_p5b_prompt_retention.sql 已在 TEST / 生产执行）：最近 7 天定稿 prompt 已在
-- ops.chat_prompt_observations，5a 起新轮次不再写 history，没有视图依赖、没有函数读写这一列。
-- 1. 守卫（锁外的普通读）：近 1 天没有新写入的 history；最近 6 天带计费快照的轮次都已在 ops；
--    没有函数正文按列名读写 history。视图依赖由 DROP COLUMN 自身（RESTRICT）拒绝。
-- 2. ALTER TABLE ... DROP COLUMN history：只改目录，排他锁拿不到 5 秒即失败（重跑即可）。
--    旧值仍在 TOAST 里（约 23GB），第三步用 pg_repack 在线重写后释放。
-- 一个 DO 块；重跑只打印已完成。pg_repack 扩展与在线重写在第三步（单独文件与 workflow 模式）。
--
-- Verify: bash scripts/test-db-reorg-p5b-drop-history.sh
-- Release: TEST -> Production（低峰）。
-- Recovery: 删列不可逆；快照副本在 ops（保留 7 天）。需要更早的完整 prompt 只能从备份恢复。

DO $drop_history$
DECLARE
  v_missing bigint;
  v_fn text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'experience.chat_history'::regclass AND attname = 'history' AND NOT attisdropped
  ) THEN
    RAISE NOTICE 'p5b: chat_history.history already dropped';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM experience.chat_history
    WHERE created_at >= now() - interval '1 day' AND history IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'p5b: history was written within the last day, refusing';
  END IF;

  SELECT count(*) INTO v_missing
  FROM experience.chat_history h
  WHERE h.created_at >= now() - interval '6 days'
    AND h.history IS NOT NULL
    AND h.llm_billing_snapshot IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM ops.chat_prompt_observations o WHERE o.history_id = h.id);
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'p5b: % recent frozen prompts are not in ops.chat_prompt_observations, refusing', v_missing;
  END IF;

  SELECT string_agg(DISTINCT n.nspname || '.' || p.proname, ', ') INTO v_fn
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND p.prosrc ~ 'chat_history'
    AND p.prosrc ~ '(\.|SET\s+|,\s*|\(\s*)history\M(?!\s*[.(])';
  IF v_fn IS NOT NULL THEN
    RAISE EXCEPTION 'p5b: functions may still use chat_history.history: %', v_fn;
  END IF;

  SET LOCAL lock_timeout = '5s';
  ALTER TABLE experience.chat_history DROP COLUMN history;
  RAISE NOTICE 'p5b: chat_history.history dropped (space is reclaimed by the pg_repack step)';
END
$drop_history$;
