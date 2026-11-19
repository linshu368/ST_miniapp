-- Domain: experience / ops（Surplus 调用）——数据库重组阶段 6a-2c-3 热修：Surplus 函数只认代表 attempt 的那一行。
-- 计划见 .trellis/tasks/11-19-db-reorg-p6-billing/design.md（6a-2c-3）。
--
-- 6a-2c-3 起畅聊并发的每一路 Surplus 调用各占 ops.llm_calls 一行（attempt_id 为空），同一轮可有多条 Surplus 行；
-- 唯一索引只保证"代表 attempt 的那一行"（attempt_id 非空）每轮一条。原先按 chat_history_id + provider='surplus'
-- 取一行的地方因此会取到多行：
--   - record_surplusintelligence_call（SELECT ... INTO STRICT）报 P0003，畅聊胜出那一路的 Surplus 元数据记不上
--     （11-19 11:26 起生产日志 chathistory.surplus_metadata.failed；写入在门控链里只记日志，不影响回复与扣费）；
--   - prepare / claim / read_surplus_call 可能取错行；
--   - 视图 miniapp_analytics.free_zone_turn_facts（Grafana 01）按轮次关联 Surplus 行，畅聊多路轮次被重复计数。
-- 本文件：四个函数各一处加 attempt_id IS NOT NULL（守卫生产原文 md5，恰好一处替换，核对结果 md5；已是新版本跳过），
-- 视图关联加同样条件（CREATE OR REPLACE，列与授权不变）。一个 DO 块。
--
-- Verify: bash scripts/test-db-reorg-p6a2c3-surplus-owner.sh
-- Release: TEST -> Production（不需要后端发布）。

DO $fix$
DECLARE
  r record;
  v_md5 text;
  v_def text;
  v_view text;
  v_fixed int := 0;
BEGIN
  SET LOCAL lock_timeout = '5s';
  FOR r IN SELECT * FROM (VALUES
    ('experience.prepare_surplusintelligence_call(uuid,uuid,jsonb)', 'ad7fd34513e437ef05aa0cb9c8c41316', 'e2c9d9be3245477ce5c8284a253aca80', $o$  SELECT * INTO l FROM ops.llm_calls WHERE chat_history_id=p_history_id AND provider='surplus' FOR UPDATE;
$o$, $n$  SELECT * INTO l FROM ops.llm_calls WHERE chat_history_id=p_history_id AND provider='surplus' AND attempt_id IS NOT NULL FOR UPDATE;
$n$),
    ('experience.record_surplusintelligence_call(uuid,jsonb)', '4e4ebff722e9e39b6beb7ea5fa7114d2', '0ecc825eb7edba88b5c2d8d9e99f3f90', $o$  SELECT * INTO STRICT l FROM ops.llm_calls WHERE chat_history_id=p_history_id AND provider='surplus' FOR UPDATE;
$o$, $n$  SELECT * INTO STRICT l FROM ops.llm_calls WHERE chat_history_id=p_history_id AND provider='surplus' AND attempt_id IS NOT NULL FOR UPDATE;
$n$),
    ('experience.claim_surplusintelligence_request_record(uuid,timestamptz)', 'ae299e95636d78e16da61ec8e6abf628', '1fed2a01d53c8bea8e92926d7043f374', $o$  SELECT * INTO l FROM ops.llm_calls WHERE chat_history_id=p_history_id AND provider='surplus' FOR UPDATE;
$o$, $n$  SELECT * INTO l FROM ops.llm_calls WHERE chat_history_id=p_history_id AND provider='surplus' AND attempt_id IS NOT NULL FOR UPDATE;
$n$),
    ('experience.read_surplus_call(uuid,boolean)', 'd043b371d45b7f3e733fd48ee2c557f3', '30b2e0080fbb19e078098761a5275592', $o$  WHERE l.chat_history_id = p_history_id AND l.provider = 'surplus'
$o$, $n$  WHERE l.chat_history_id = p_history_id AND l.provider = 'surplus' AND l.attempt_id IS NOT NULL
$n$)
  ) AS t(fn, old_md5, new_md5, old_line, new_line) LOOP
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = r.fn::regprocedure;
    IF v_md5 = r.new_md5 THEN
      CONTINUE;
    ELSIF v_md5 <> r.old_md5 THEN
      RAISE EXCEPTION 'p6a2c3s: % drifted (md5 %), refusing', r.fn, v_md5;
    END IF;
    v_def := pg_get_functiondef(r.fn::regprocedure);
    IF (length(v_def) - length(replace(v_def, r.old_line, ''))) / length(r.old_line) <> 1 THEN
      RAISE EXCEPTION 'p6a2c3s: anchor not found exactly once in %', r.fn;
    END IF;
    EXECUTE replace(v_def, r.old_line, r.new_line);
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = r.fn::regprocedure;
    IF v_md5 <> r.new_md5 THEN
      RAISE EXCEPTION 'p6a2c3s: unexpected md5 % for %', v_md5, r.fn;
    END IF;
    v_fixed := v_fixed + 1;
  END LOOP;

  v_view := pg_get_viewdef('miniapp_analytics.free_zone_turn_facts'::regclass);
  IF v_view NOT LIKE '%s.attempt_id IS NOT NULL%' THEN
    IF (length(v_view) - length(replace(v_view, $a$(s.provider = 'surplus'::text)$a$, '')))
       / length($a$(s.provider = 'surplus'::text)$a$) <> 1 THEN
      RAISE EXCEPTION 'p6a2c3s: free_zone_turn_facts join anchor not found exactly once';
    END IF;
    EXECUTE 'CREATE OR REPLACE VIEW miniapp_analytics.free_zone_turn_facts AS '
      || replace(v_view, $a$(s.provider = 'surplus'::text)$a$,
                 $b$(s.provider = 'surplus'::text) AND (s.attempt_id IS NOT NULL)$b$);
    v_fixed := v_fixed + 1;
  END IF;
  RAISE NOTICE 'p6a2c3s: % objects now use the row representing the attempt', v_fixed;
END
$fix$;
