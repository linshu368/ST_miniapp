-- Domain: billing / experience（文本扣费的读方）——数据库重组阶段 6b-1b 读方切换（二）：4 个数据库函数改读 billing.usage_charges。
-- 计划见 .trellis/tasks/11-19-db-reorg-p6-billing/design.md（6b-1b / 6b-1c 拆解）。
--
-- 改读的函数（只读的地方换来源，其余逻辑不动；输出列名、类型不变，后端不用改）：
--   - billing.chat_delivery_billing_gate：用户停止计费判断读的报价快照 → usage_charges.quote.snapshot（按 p_charge_key 主键取）；
--   - experience.list_chat_settlement_candidates：快照、结算时间 → usage_charges（按 llm_charge_id 关联）。
--     没有计费编号的轮次（报了价但开轮前失败）不再出现：结算本来就跳过它们（reconcileCharge 无编号返回未结算，
--     缺调用编号的扫描只记 manual_audit 告警），改读后只是不再白占每次 50 条的扫描名额；
--   - experience.list_llm_call_metadata_gaps：快照、结算时间 → usage_charges（交付过的轮次都有编号，近 30 天反例 0）；
--   - experience.save_chat_reply_feedback：反馈记录的供应商、供应商模型 → usage_charges.quote.snapshot（继承轮次取源轮次）。
-- 不在本文件：select_chat_generation_delivery 既读又写快照，和看板日汇总 refresh_grafana_core_day 一起归 6b-1c（写方切换）；
--   list_chat_message_page 读展示视图，上一步已切换。
-- 本文件：
--   1. 前置守卫（只读）：近 3 天有编号的轮次，快照、结算时间与 usage_charges 逐行相等；交付过却没有编号的轮次为 0；
--   2. 一个事务里逐个按原文 md5 守卫、每处锚点恰好命中预定次数、核对结果 md5 地替换（已是新版本跳过）。
--      替换函数不锁业务表；lock_timeout 1 秒；
--   3. 自检：两个扫描函数各跑一次。
--
-- Verify: bash scripts/test-db-reorg-p6b1b-reader-functions.sh
-- Release: TEST -> Production（不需要后端发布）。回滚：按原文 md5 反向替换（锚点与本文件互换）。

DO $guard$
DECLARE
  v_snapshot bigint;
  v_settled bigint;
  v_unlinked bigint;
BEGIN
  SELECT count(*) FILTER (WHERE (u.quote -> 'snapshot') IS DISTINCT FROM h.llm_billing_snapshot),
         count(*) FILTER (WHERE u.settled_at IS DISTINCT FROM h.llm_billing_settled_at)
  INTO v_snapshot, v_settled
  FROM experience.chat_history h JOIN billing.usage_charges u ON u.id = h.llm_charge_id
  WHERE h.created_at > now() - interval '3 days';
  SELECT count(*) INTO v_unlinked
  FROM experience.chat_history h JOIN experience.chat_generation_requests r ON r.chat_history_id = h.id
  WHERE h.created_at > now() - interval '3 days' AND r.delivery_attempt_id IS NOT NULL AND h.llm_charge_id IS NULL;
  IF v_snapshot > 0 OR v_settled > 0 OR v_unlinked > 0 THEN
    RAISE EXCEPTION 'p6b1b-readers: % snapshots / % settled_at differ from usage_charges, % delivered turns lack a charge id; refusing',
      v_snapshot, v_settled, v_unlinked;
  END IF;
  RAISE NOTICE 'p6b1b-readers: last 3 days of quotes and settlements match usage_charges row by row';
END
$guard$;

CREATE OR REPLACE FUNCTION billing.p6b1b_patch_function(p_fn regprocedure, p_from text, p_to text, p_edits text[])
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_md5 text;
  v_def text;
  v_old text;
  v_count int;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = p_fn;
  IF v_md5 = p_to THEN
    RETURN format('%s already reads usage_charges', p_fn);
  ELSIF v_md5 <> p_from THEN
    RAISE EXCEPTION 'p6b1b-readers: % drifted (md5 %), refusing', p_fn, v_md5;
  END IF;
  v_def := pg_get_functiondef(p_fn);
  FOR i IN 1 .. array_length(p_edits, 1) / 3 LOOP
    v_old := p_edits[3 * i - 2];
    v_count := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    IF v_count <> p_edits[3 * i]::int THEN
      RAISE EXCEPTION 'p6b1b-readers: % anchor % found % times, expected %', p_fn, i, v_count, p_edits[3 * i];
    END IF;
    v_def := replace(v_def, v_old, p_edits[3 * i - 1]);
  END LOOP;
  EXECUTE v_def;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = p_fn;
  IF v_md5 <> p_to THEN
    RAISE EXCEPTION 'p6b1b-readers: % has md5 % after the patch', p_fn, v_md5;
  END IF;
  RETURN format('%s now reads usage_charges', p_fn);
END
$fn$;

DO $patch$
BEGIN
  SET LOCAL lock_timeout = '1s';
  RAISE NOTICE 'p6b1b-readers: %', billing.p6b1b_patch_function(
    'billing.chat_delivery_billing_gate(uuid)'::regprocedure,
    '9212526b76f7bbb588beca78a57525b8', 'e87217dd005870c5dd0635fa0289ee73',
    ARRAY[
      $o1$DECLARE r experience.chat_generation_requests%ROWTYPE; h experience.chat_history%ROWTYPE;
BEGIN
$o1$,
      $n1$DECLARE r experience.chat_generation_requests%ROWTYPE; h experience.chat_history%ROWTYPE; v_snapshot jsonb;
BEGIN
$n1$,
      '1',
      $o2$  IF NOT FOUND OR NOT r.requires_visible_token THEN RETURN 'legacy'; END IF;
$o2$,
      $n2$  IF NOT FOUND OR NOT r.requires_visible_token THEN RETURN 'legacy'; END IF;
  -- db reorg 6b-1b: the frozen quote is read from billing.usage_charges, the row p_charge_key names.
  SELECT u.quote -> 'snapshot' INTO v_snapshot FROM billing.usage_charges u WHERE u.id = p_charge_key;
$n2$,
      '1',
      $o3$h.llm_billing_snapshot$o3$,
      $n3$v_snapshot$n3$,
      '6']);
  RAISE NOTICE 'p6b1b-readers: %', billing.p6b1b_patch_function(
    'experience.list_chat_settlement_candidates(text,timestamp with time zone,integer,timestamp with time zone)'::regprocedure,
    '32f92b0952bf068801824dff36966815', '44f73038f32828b16f9d5f5559123daf',
    ARRAY[
      $o1$    h.llm_billing_snapshot, h.llm_billing_settled_at, a.provider, a.generation_id
  FROM experience.chat_history h
$o1$,
      $n1$    uc.quote -> 'snapshot', uc.settled_at, a.provider, a.generation_id
  FROM experience.chat_history h
  -- db reorg 6b-1b: quote and settlement live in billing.usage_charges. A turn without a charge id never settles
  -- (reconcileCharge skips it), so it no longer takes a slot of the scan budget.
  JOIN billing.usage_charges uc ON uc.id = h.llm_charge_id
$n1$,
      '1',
      $o2$    AND h.llm_billing_snapshot IS NOT NULL
    AND h.llm_billing_settled_at IS NULL
$o2$,
      $n2$    AND uc.quote ? 'snapshot'
    AND uc.settled_at IS NULL
$n2$,
      '1',
      $o3$h.llm_billing_snapshot ->> 'provider' = 'surplus'$o3$,
      $n3$uc.quote -> 'snapshot' ->> 'provider' = 'surplus'$n3$,
      '1']);
  RAISE NOTICE 'p6b1b-readers: %', billing.p6b1b_patch_function(
    'experience.list_llm_call_metadata_gaps(timestamp with time zone,integer)'::regprocedure,
    '4d4e121b588cd14f67d3abcbe6b92d3e', '2da1fda54ade0185b377c296014ce8cb',
    ARRAY[
      $o1$    h.llm_billing_snapshot, h.llm_billing_settled_at, a.provider, a.generation_id
  FROM experience.chat_history h
$o1$,
      $n1$    uc.quote -> 'snapshot', uc.settled_at, a.provider, a.generation_id
  FROM experience.chat_history h
  -- db reorg 6b-1b: quote and settlement live in billing.usage_charges.
  LEFT JOIN billing.usage_charges uc ON uc.id = h.llm_charge_id
$n1$,
      '1']);
  RAISE NOTICE 'p6b1b-readers: %', billing.p6b1b_patch_function(
    'experience.save_chat_reply_feedback(uuid,uuid,uuid,integer,text[],text)'::regprocedure,
    'bbff90fd7a7611f17817cac2c32f8f21', '622c5c951046648a4f8adce82f972652',
    ARRAY[
      $o1$  SELECT h.*,raw.llm_billing_snapshot INTO v_row
  FROM experience.session_chat_history h JOIN experience.chat_history raw ON raw.id=h.id
$o1$,
      $n1$  -- db reorg 6b-1b: the delivered provider comes from the quote in billing.usage_charges (inherited turns use the source turn's).
  SELECT h.*,uc.quote->'snapshot' AS llm_billing_snapshot INTO v_row
  FROM experience.session_chat_history h JOIN experience.chat_history raw ON raw.id=h.id
  LEFT JOIN billing.usage_charges uc ON uc.id=raw.llm_charge_id
$n1$,
      '1']);
END
$patch$;

DROP FUNCTION billing.p6b1b_patch_function(regprocedure, text, text, text[]);

DO $check$
DECLARE
  v_candidates bigint;
  v_gaps bigint;
BEGIN
  SELECT count(*) INTO v_candidates FROM experience.list_chat_settlement_candidates('openrouter', now() - interval '1 hour', 50);
  SELECT count(*) INTO v_gaps FROM experience.list_llm_call_metadata_gaps(now() - interval '1 hour', 50);
  RAISE NOTICE 'p6b1b-readers: scans run (% settlement candidates, % metadata gaps in the last hour)', v_candidates, v_gaps;
END
$check$;
