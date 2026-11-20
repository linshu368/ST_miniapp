-- Domain: experience（语音）/ billing（语音扣费函数）——数据库重组阶段 6a-3：删语音生成耗时列 chat_message_audio.latency_ms。
-- 计划见 .trellis/tasks/11-19-db-reorg-p6-billing/design.md（6a-3）。
--
-- 原计划把它挪进新建的 ops.media_generation_calls。核对后不建表（同 6a-1 的做法）：
--   - 没有读者：没有视图、函数读它，后端只写不读；耗时已经在后端日志 voice.generate.done / failed 等事件里；
--   - 聊天配图已下线（4b），媒体调用观测只剩这一列。
-- 写入方：后端仓库（随本步后端发布停写）+ 两个语音扣费函数把 p_metadata.latency_ms 写回本列（只是赋值，与金额无关）。
-- 本文件（后端发布、确认停写后执行）：
--   1. charge_voice_usage / settle_voice_generation 去掉 latency_ms 赋值（守卫生产原文 md5，恰好一处替换，核对结果 md5；已是新版本跳过）；
--      提交后等 5 秒，让排队中的旧函数调用走完。
--   2. 守卫：近 15 分钟没有新写入的 latency_ms（后端已停写），且没有函数再引用本列；然后删列。
--
-- Verify: bash scripts/test-db-reorg-p6a3-voice-latency.sh
-- Release: 后端发布（停写）→ TEST → Production。

DO $patch$
DECLARE
  r record;
  v_md5 text;
  v_def text;
  v_done int := 0;
BEGIN
  SET LOCAL lock_timeout = '5s';
  FOR r IN SELECT * FROM (VALUES
    ('billing.charge_voice_usage(uuid,uuid,uuid,numeric,jsonb)', '641552b7d5e3e89f51bb734233e2d637', 'aaf7970d3b2e76cfb35d9d15a67734fb',
     ARRAY[$o$latency_ms=COALESCE(NULLIF(p_metadata->>'latency_ms','')::INTEGER, latency_ms), error_code=NULL,$o$],
     ARRAY[$n$error_code=NULL,$n$]),
    ('billing.settle_voice_generation(uuid,uuid,numeric,jsonb)', '32795fc21cf7ff9b7e8d7eac0d2e1b70', '44fa84e5e62252aaa672a828a3633a02',
     ARRAY[E'\n          latency_ms = COALESCE(NULLIF(p_metadata ->> ''latency_ms'', '''')::integer, latency_ms),',
           E'\n        latency_ms = COALESCE(NULLIF(p_metadata ->> ''latency_ms'', '''')::integer, latency_ms),',
           E'\n      latency_ms = COALESCE(NULLIF(p_metadata ->> ''latency_ms'', '''')::integer, latency_ms),'],
     ARRAY['', '', ''])
  ) AS t(fn, old_md5, new_md5, olds, news) LOOP
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = r.fn::regprocedure;
    IF v_md5 = r.new_md5 THEN
      CONTINUE;
    ELSIF v_md5 <> r.old_md5 THEN
      RAISE EXCEPTION 'p6a3: % drifted (md5 %), refusing', r.fn, v_md5;
    END IF;
    v_def := pg_get_functiondef(r.fn::regprocedure);
    FOR i IN 1 .. array_length(r.olds, 1) LOOP
      IF (length(v_def) - length(replace(v_def, r.olds[i], ''))) / length(r.olds[i]) <> 1 THEN
        RAISE EXCEPTION 'p6a3: anchor % not found exactly once in %', i, r.fn;
      END IF;
      v_def := replace(v_def, r.olds[i], r.news[i]);
    END LOOP;
    EXECUTE v_def;
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = r.fn::regprocedure;
    IF v_md5 <> r.new_md5 THEN
      RAISE EXCEPTION 'p6a3: unexpected md5 % for %', v_md5, r.fn;
    END IF;
    v_done := v_done + 1;
  END LOOP;
  RAISE NOTICE 'p6a3: % voice billing functions no longer write latency_ms', v_done;
END
$patch$;

SELECT pg_sleep(5);

DO $drop$
DECLARE
  v_recent bigint;
  v_refs text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'experience.chat_message_audio'::regclass
                 AND attname = 'latency_ms' AND NOT attisdropped) THEN
    RAISE NOTICE 'p6a3: chat_message_audio.latency_ms already dropped';
    RETURN;
  END IF;
  EXECUTE 'SELECT count(*) FROM experience.chat_message_audio
           WHERE latency_ms IS NOT NULL AND updated_at > now() - interval ''15 minutes''' INTO v_recent;
  IF v_recent > 0 THEN
    RAISE EXCEPTION 'p6a3: % rows wrote latency_ms in the last 15 minutes; release the backend first', v_recent;
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_refs
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND p.prosrc ~ 'chat_message_audio' AND p.prosrc ~ '\mlatency_ms\M';
  IF v_refs IS NOT NULL THEN
    RAISE EXCEPTION 'p6a3: functions still reference latency_ms: %', v_refs;
  END IF;
  SET LOCAL lock_timeout = '5s';
  ALTER TABLE experience.chat_message_audio DROP COLUMN latency_ms;
  RAISE NOTICE 'p6a3: chat_message_audio.latency_ms dropped';
END
$drop$;
