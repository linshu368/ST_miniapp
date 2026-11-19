-- Domain: experience / ops（落败调用片段）——数据库重组阶段 6a-2c-3 收缩（二）：落败片段只在 ops.llm_calls。
-- 计划见 .trellis/tasks/11-19-db-reorg-p6-billing/design.md（6a-2c-3）。
--
-- 竞速里落败（race_lost）调用的正文片段原来写在 experience.chat_generation_attempts.discarded_response（7 千多行），
-- 扩展时已复制到 ops.llm_calls.discarded_detail。本文件：
--   1. experience.observe_chat_generation_attempt 改为把片段写进 ops.llm_calls（attempt 那一行，只补空值），终态守卫
--      改看 ops.llm_calls 里是否已有片段（语义不变：落败调用一旦记下片段，重放/后到的快照不再更新）；
--      守卫生产原文 md5 3a7ef089e58b04174321c40e984235bd，三处恰好一次替换，结果 md5 00305dbb27cbdfdcc0f554b48b1156a8。
--      提交后等 5 秒，让进行中的旧函数调用结束。
--   2. 补复制扩展之后新写的片段（只补空值），删 attempts.discarded_response（视图依赖由 DROP COLUMN 自身拒绝）。
-- 第二段失败时第一段已生效，按原文件重跑即可。
--
-- Verify: bash scripts/test-db-reorg-p6a2c3-discarded.sh
-- Release: TEST -> Production（不需要后端发布：后端仍按原 RPC 入参上报片段）。
-- Recovery: 片段在 ops.llm_calls.discarded_detail；需要回退时恢复函数原文（本文件头部 md5）并加回列。

DO $observe$
DECLARE
  v_fn CONSTANT regprocedure := 'experience.observe_chat_generation_attempt(uuid,jsonb)'::regprocedure;
  v_md5 text;
  v_def text;
  v_old text;
BEGIN
  SET LOCAL lock_timeout = '5s';
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_fn;
  IF v_md5 = '00305dbb27cbdfdcc0f554b48b1156a8' THEN
    RAISE NOTICE 'p6a2c3d: observe_chat_generation_attempt already writes ops.llm_calls';
    RETURN;
  END IF;
  IF v_md5 <> '3a7ef089e58b04174321c40e984235bd' THEN
    RAISE EXCEPTION 'p6a2c3d: observe_chat_generation_attempt drifted (md5 %), refusing', v_md5;
  END IF;
  v_def := pg_get_functiondef(v_fn);
  FOREACH v_old IN ARRAY ARRAY[
      $o0$  -- A stopped loser is terminal. Replayed/later snapshots cannot overwrite or
  -- enlarge its diagnostic payload, and duplicate reports cause no UPDATE.
  IF a.discarded_response IS NOT NULL THEN RETURN; END IF;
$o0$,
      $o1$    discarded_response=v_discarded,
$o1$,
      $o2$  WHERE id=a.id;
END;
$o2$
  ] LOOP
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION 'p6a2c3d: observe anchor not found exactly once: %', left(v_old, 60);
    END IF;
  END LOOP;
    v_def := replace(v_def, $o0$  -- A stopped loser is terminal. Replayed/later snapshots cannot overwrite or
  -- enlarge its diagnostic payload, and duplicate reports cause no UPDATE.
  IF a.discarded_response IS NOT NULL THEN RETURN; END IF;
$o0$, $r0$  -- A stopped loser is terminal (db reorg 6a-2c-3: its fragment lives in ops.llm_calls.discarded_detail).
  -- Replayed/later snapshots cannot overwrite or enlarge it, and duplicate reports cause no UPDATE.
  IF EXISTS (SELECT 1 FROM ops.llm_calls l WHERE l.id=a.id AND l.discarded_detail IS NOT NULL) THEN RETURN; END IF;
$r0$);
    v_def := replace(v_def, $o1$    discarded_response=v_discarded,
$o1$, $r1$$r1$);
    v_def := replace(v_def, $o2$  WHERE id=a.id;
END;
$o2$, $r2$  WHERE id=a.id;
  IF v_discarded IS NOT NULL THEN
    INSERT INTO ops.llm_calls AS l (id,attempt_id,chat_history_id,provider,model,generation_id,discarded_detail)
    VALUES (a.id,a.id,a.chat_history_id,a.provider,a.provider_model_id,
            COALESCE(a.generation_id,p_observation->>'generation_id'),v_discarded)
    ON CONFLICT (id) DO UPDATE SET discarded_detail=COALESCE(l.discarded_detail,EXCLUDED.discarded_detail),updated_at=now();
  END IF;
END;
$r2$);
  EXECUTE v_def;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_fn;
  IF v_md5 <> '00305dbb27cbdfdcc0f554b48b1156a8' THEN
    RAISE EXCEPTION 'p6a2c3d: unexpected observe md5 %', v_md5;
  END IF;
  RAISE NOTICE 'p6a2c3d: observe_chat_generation_attempt writes fragments to ops.llm_calls';
END
$observe$;

-- In-flight calls of the old function may still write the column; let them finish before it goes.
SELECT pg_sleep(5);

DO $drop_column$
DECLARE
  v_copied bigint := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'experience.chat_generation_attempts'::regclass
                 AND attname = 'discarded_response' AND NOT attisdropped) THEN
    RAISE NOTICE 'p6a2c3d: discarded_response already dropped';
    RETURN;
  END IF;
  SET LOCAL lock_timeout = '5s';
  INSERT INTO ops.llm_calls AS l (id, attempt_id, chat_history_id, provider, model, generation_id, discarded_detail)
  SELECT a.id, a.id, a.chat_history_id, a.provider, a.provider_model_id, a.generation_id, a.discarded_response
    FROM experience.chat_generation_attempts a
   WHERE a.discarded_response IS NOT NULL
     AND a.provider IN ('openrouter', 'venice', 'surplus')
  ON CONFLICT (id) DO UPDATE SET discarded_detail = COALESCE(l.discarded_detail, EXCLUDED.discarded_detail),
    updated_at = now()
  WHERE l.discarded_detail IS NULL;
  GET DIAGNOSTICS v_copied = ROW_COUNT;
  ALTER TABLE experience.chat_generation_attempts DROP COLUMN discarded_response;
  RAISE NOTICE 'p6a2c3d: % late fragments copied, attempts.discarded_response dropped', v_copied;
END
$drop_column$;
