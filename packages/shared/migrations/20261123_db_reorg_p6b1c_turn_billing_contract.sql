-- Domain: billing（文本计费）——数据库重组阶段 6b-1c 写方切换（三）收缩：轮次计费只在 billing.usage_charges。
-- 设计见 .trellis/tasks/11-19-db-reorg-p6-billing/design.md「写方切换 PR③～⑤（收尾合并）」。
-- 前置：20261123_db_reorg_p6b1c_turn_billing_rpc.sql 已执行，且后端已发布为只经
-- billing.record_chat_turn_charge / billing.save_chat_turn_quote 写计费结果（不再直接 UPDATE 轮次计费列）。
--
-- 本文件每个 DO 块单独提交（psql 逐条执行），都能重跑：
--   1. 守卫（只读）：两个写入口已存在；只有已知函数和两个展示视图引用要删的列与旧表；旧扣费表、去重表的每个
--      key 在 usage_charges 都有行且金额、状态、流水一致；已关联轮次的 4 个计费列与 usage_charges 逐行一致；
--   2. 切换（一个事务，不锁业务表）：两个写入口改为直写 usage_charges（语义与镜像触发器相同）；开轮函数的报价快照、
--      交付函数的供应商改写 usage_charges.quote.snapshot（锚点恰好命中、改后不再出现旧列）；轮次镜像触发器函数改为空操作；
--   3. 等 5 秒，让切换前已开始的旧版调用走完；
--   4. 补漏与老数据：切换窗口里旧版调用只写进轮次列的值补进 usage_charges（预期 0）；没有计费编号的老轮次
--      （7 月、9 月付费 3173 轮）补计费行和编号，有报价快照的失败轮次把快照收进计费行；超过结算窗口（24 小时）还停在
--      quoted 的报价给结束状态（交付成功的记 waived，其余 failed）；
--   5. 读方去掉旧列回退：看板日汇总（新旧函数各刷一遍昨天的看板，结果相同才切换）、两个展示视图；
--   6. 删轮次镜像触发器和 4 个计费列（拿锁上限 1 秒、重试）；
--   7. 删旧扣费表、去重表及其触发器函数、旧重载 grant_character_creator_reward(llm_usage_charges)；
--   8. 自检。
--
-- Verify: bash scripts/test-db-reorg-p6b1c-turn-billing.sh
-- Release: TEST -> Production。前后跑 R1 文本按日对账。
-- Rollback: forward-fix。删列前的状态可由 usage_charges 重建（4 列的值都在 usage_charges 里）。

DO $guard$
DECLARE
  v_bad text;
  v_n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'experience' AND table_name = 'chat_history' AND column_name = 'llm_billing_snapshot') THEN
    RAISE NOTICE 'p6b1c-turn-billing: chat_history billing columns already dropped, skipping guards';
    RETURN;
  END IF;
  IF to_regprocedure('billing.record_chat_turn_charge(uuid,numeric,numeric,timestamptz)') IS NULL
     OR to_regprocedure('billing.save_chat_turn_quote(uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'p6b1c-turn-billing: apply 20261123_db_reorg_p6b1c_turn_billing_rpc.sql and release the backend first';
  END IF;

  -- 提到这些名字的函数只能是下面这些（其余出现在注释里，或是视图输出列名 deduction_rate）。
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND p.prosrc ~ '(llm_usage_charges\M|llm_usage_charge_dedup|deduction_rate|llm_billing_snapshot|llm_billing_settled_at|llm_intended_deduction)'
    AND n.nspname || '.' || p.proname NOT IN (
      'experience.begin_chat_generation_observation', 'experience.select_chat_generation_delivery',
      'billing.record_chat_turn_charge', 'billing.save_chat_turn_quote', 'analytics.refresh_core_daily',
      'experience.list_chat_message_page', 'experience.save_chat_reply_feedback',
      'billing.tf_mirror_chat_history_charge', 'billing.tf_mirror_llm_usage_charge',
      'billing.prepare_llm_usage_charge', 'billing.retain_recent_llm_usage_charges',
      'billing.charge_llm_usage', 'billing.chat_archived_charge_result', 'billing.grant_character_creator_reward');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'p6b1c-turn-billing: unexpected functions reference the dropped billing objects: %', v_bad;
  END IF;
  SELECT string_agg(DISTINCT v.oid::regclass::text, ', ') INTO v_bad
  FROM pg_depend d
  JOIN pg_rewrite r ON r.oid = d.objid
  JOIN pg_class v ON v.oid = r.ev_class
  JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
  WHERE d.refobjid = 'experience.chat_history'::regclass
    AND a.attname IN ('deduction_rate', 'llm_billing_snapshot', 'llm_billing_settled_at', 'llm_intended_deduction')
    AND v.oid NOT IN ('experience.chat_history_display'::regclass, 'experience.session_chat_history'::regclass);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'p6b1c-turn-billing: unexpected views read the billing columns: %', v_bad;
  END IF;

  IF to_regclass('billing.llm_usage_charges') IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM billing.llm_usage_charges c
    LEFT JOIN billing.usage_charges u ON u.id = c.charge_key
    WHERE u.id IS NULL OR u.charged_credits <> c.charged_amount OR u.status <> c.status
       OR u.debit_ledger_id IS DISTINCT FROM c.debit_ledger_id;
    IF v_n > 0 THEN
      RAISE EXCEPTION 'p6b1c-turn-billing: % old charge rows are missing or differ in usage_charges', v_n;
    END IF;
  END IF;
  IF to_regclass('billing.llm_usage_charge_dedup') IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM billing.llm_usage_charge_dedup d
    LEFT JOIN billing.usage_charges u ON u.id = d.charge_key
    WHERE u.id IS NULL OR u.charged_credits <> d.charged_amount;
    IF v_n > 0 THEN
      RAISE EXCEPTION 'p6b1c-turn-billing: % dedup keys are missing or differ in usage_charges', v_n;
    END IF;
  END IF;

  -- 镜像一直在同步：已关联轮次的计费列与 usage_charges 逐行相同（快照比较较慢，只看近 3 天，更早的 6b-1b 已全量核对）。
  EXECUTE $q$
    SELECT count(*) FROM experience.chat_history h
    LEFT JOIN billing.usage_charges u ON u.id = h.llm_charge_id
    WHERE h.llm_charge_id IS NOT NULL
      AND (u.id IS NULL
        OR u.charged_credits IS DISTINCT FROM COALESCE(h.deduction_rate, 0)
        OR (h.llm_intended_deduction IS NOT NULL AND u.quoted_credits IS DISTINCT FROM h.llm_intended_deduction)
        OR (h.llm_billing_settled_at IS NOT NULL AND u.settled_at IS DISTINCT FROM h.llm_billing_settled_at)
        OR (h.created_at > now() - interval '3 days' AND h.llm_billing_snapshot IS NOT NULL
            AND (u.quote -> 'snapshot') IS DISTINCT FROM h.llm_billing_snapshot))
  $q$ INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'p6b1c-turn-billing: % linked turns differ from usage_charges; refusing', v_n;
  END IF;
  RAISE NOTICE 'p6b1c-turn-billing: guards passed';
END
$guard$;

DO $switch$
DECLARE
  v_begin regprocedure := 'experience.begin_chat_generation_observation(uuid,jsonb)'::regprocedure;
  v_delivery regprocedure := 'experience.select_chat_generation_delivery(uuid,uuid,text)'::regprocedure;
  v_def text;
  c_guard constant text := $a$(p_input ? 'snapshot' OR h.llm_billing_snapshot IS NULL)$a$;
  c_guard_new constant text := $a$(p_input ? 'snapshot' OR NOT EXISTS (SELECT 1 FROM billing.usage_charges u WHERE u.id=h.llm_charge_id AND u.quote ? 'snapshot'))$a$;
  c_set constant text := E',\n        llm_billing_snapshot=CASE WHEN p_input ? ''snapshot'' THEN p_input->''snapshot'' ELSE llm_billing_snapshot END\n      WHERE id=p_history_id;';
  c_set_new constant text := E'\n      WHERE id=p_history_id;\n      -- db reorg 6b-1c: the frozen quote lives in billing.usage_charges.quote.snapshot.\n      IF p_input ? ''snapshot'' THEN PERFORM billing.save_chat_turn_quote(p_history_id,p_input->''snapshot''); END IF;';
  c_route constant text := $a$UPDATE experience.chat_history SET llm_billing_snapshot=llm_billing_snapshot || jsonb_build_object('provider',a.provider,'provider_model_id',a.provider_model_id) WHERE id=p_history_id;$a$;
  c_route_new constant text := $a$UPDATE billing.usage_charges SET quote=jsonb_set(quote,'{snapshot}',(quote->'snapshot') || jsonb_build_object('provider',a.provider,'provider_model_id',a.provider_model_id)),updated_at=now() WHERE id=h.llm_charge_id;$a$;
  n_old int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'experience' AND table_name = 'chat_history' AND column_name = 'llm_billing_snapshot') THEN
    RAISE NOTICE 'p6b1c-turn-billing: already contracted, skipping the switch';
    RETURN;
  END IF;

  -- 两个写入口：直写 usage_charges，结果与"写轮次计费列 → 镜像触发器"相同。
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION billing.record_chat_turn_charge(
  p_history_id uuid,
  p_charged_credits numeric,
  p_quoted_credits numeric,
  p_settled_at timestamptz
)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  h record;
BEGIN
  SELECT id, user_id, status, llm_charge_id, created_at INTO h FROM experience.chat_history WHERE id = p_history_id;
  -- 没有计费编号的轮次（开轮前被拒、失败路径清了编号）不记计费结果。
  IF NOT FOUND OR h.llm_charge_id IS NULL THEN
    RETURN;
  END IF;
  -- null 参数不改。有扣费明细（quote.charge）的行，状态与实扣以扣费函数为准；
  -- 没有的由轮次结果定：未结算 quoted、成功 free、其余 failed。
  INSERT INTO billing.usage_charges AS u
    (id, user_id, kind, subject_id, status, quoted_credits, charged_credits, settled_at, created_at, updated_at)
  VALUES (h.llm_charge_id, h.user_id, 'chat_text', h.id,
    CASE WHEN p_settled_at IS NULL THEN 'quoted' WHEN h.status = 'success' THEN 'free' ELSE 'failed' END,
    p_quoted_credits, COALESCE(p_charged_credits, 0), p_settled_at, h.created_at, now())
  ON CONFLICT (id) DO UPDATE SET
    subject_id = COALESCE(u.subject_id, EXCLUDED.subject_id),
    quoted_credits = COALESCE(EXCLUDED.quoted_credits, u.quoted_credits),
    status = CASE
      WHEN u.quote ? 'charge' THEN u.status
      WHEN COALESCE(EXCLUDED.settled_at, u.settled_at) IS NULL THEN 'quoted'
      WHEN h.status = 'success' THEN 'free'
      ELSE 'failed'
    END,
    charged_credits = CASE WHEN u.quote ? 'charge' THEN u.charged_credits ELSE COALESCE(p_charged_credits, u.charged_credits) END,
    settled_at = COALESCE(EXCLUDED.settled_at, u.settled_at),
    updated_at = now();
END
$fn$
  $ddl$;
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION billing.save_chat_turn_quote(p_history_id uuid, p_snapshot jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  h record;
BEGIN
  IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid billing snapshot' USING ERRCODE = '22023';
  END IF;
  SELECT id, user_id, llm_charge_id, created_at INTO h FROM experience.chat_history WHERE id = p_history_id;
  -- 报价跟着这一轮的计费编号走；没有编号的轮次（失败路径清了编号）不再落报价。
  IF NOT FOUND OR h.llm_charge_id IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO billing.usage_charges AS u (id, user_id, kind, subject_id, status, quote, created_at, updated_at)
  VALUES (h.llm_charge_id, h.user_id, 'chat_text', h.id, 'quoted', jsonb_build_object('snapshot', p_snapshot), h.created_at, now())
  ON CONFLICT (id) DO UPDATE SET
    subject_id = COALESCE(u.subject_id, EXCLUDED.subject_id),
    quote = u.quote || EXCLUDED.quote,
    updated_at = now();
END
$fn$
  $ddl$;

  -- 开轮函数：报价快照改写 usage_charges；"本轮是否已有快照"改看 usage_charges。
  SELECT pg_get_functiondef(v_begin) INTO v_def;
  IF position('llm_billing_snapshot' IN v_def) > 0 THEN
    n_old := (length(v_def) - length(replace(v_def, c_guard, ''))) / length(c_guard);
    IF n_old <> 1 THEN RAISE EXCEPTION 'p6b1c-turn-billing: begin snapshot guard found % times, expected 1', n_old; END IF;
    n_old := (length(v_def) - length(replace(v_def, c_set, ''))) / length(c_set);
    IF n_old <> 2 THEN RAISE EXCEPTION 'p6b1c-turn-billing: begin snapshot write found % times, expected 2', n_old; END IF;
    v_def := replace(replace(v_def, c_guard, c_guard_new), c_set, c_set_new);
    IF position('llm_billing_snapshot' IN v_def) > 0 THEN
      RAISE EXCEPTION 'p6b1c-turn-billing: begin still references llm_billing_snapshot after the patch';
    END IF;
    EXECUTE v_def;
  END IF;

  -- 交付函数：供应商写进 usage_charges 的报价快照（守卫已保证这一行有快照）。
  SELECT pg_get_functiondef(v_delivery) INTO v_def;
  IF position('llm_billing_snapshot' IN v_def) > 0 THEN
    n_old := (length(v_def) - length(replace(v_def, c_route, ''))) / length(c_route);
    IF n_old <> 1 THEN RAISE EXCEPTION 'p6b1c-turn-billing: delivery routing write found % times, expected 1', n_old; END IF;
    v_def := replace(v_def, c_route, c_route_new);
    IF position('llm_billing_snapshot' IN v_def) > 0 THEN
      RAISE EXCEPTION 'p6b1c-turn-billing: delivery still references llm_billing_snapshot after the patch';
    END IF;
    EXECUTE v_def;
  END IF;

  -- 轮次镜像改为空操作（触发器本身随删列一起删，那一步才拿表锁）。
  IF to_regprocedure('billing.tf_mirror_chat_history_charge()') IS NOT NULL THEN
    EXECUTE $ddl$
CREATE OR REPLACE FUNCTION billing.tf_mirror_chat_history_charge()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  -- db reorg 6b-1c: turn billing is written to billing.usage_charges directly; dropped with the billing columns.
  RETURN NULL;
END
$fn$
    $ddl$;
  END IF;
  RAISE NOTICE 'p6b1c-turn-billing: writers now write usage_charges directly';
END
$switch$;

SELECT pg_sleep(5);

DO $legacy$
DECLARE
  v_healed bigint;
  v_linked bigint := 0;
  v_snapshots bigint := 0;
  v_closed bigint;
  r record;
  v_id uuid;
  v_existing billing.usage_charges%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'experience' AND table_name = 'chat_history' AND column_name = 'llm_billing_snapshot') THEN
    RAISE NOTICE 'p6b1c-turn-billing: already contracted, skipping legacy backfill';
    RETURN;
  END IF;

  -- 1. 切换那一刻已在执行的旧版调用只写了轮次列：把 usage_charges 缺的值补上（与镜像同口径；预期 0）。
  EXECUTE $q$
    WITH lost AS (
      SELECT h.id, h.llm_charge_id, h.status, h.deduction_rate, h.llm_intended_deduction, h.llm_billing_settled_at, h.llm_billing_snapshot
      FROM experience.chat_history h JOIN billing.usage_charges u ON u.id = h.llm_charge_id
      WHERE h.created_at > now() - interval '2 days'
        AND ((h.llm_billing_settled_at IS NOT NULL AND u.settled_at IS NULL)
          OR (h.llm_intended_deduction IS NOT NULL AND u.quoted_credits IS NULL)
          OR (NOT (u.quote ? 'charge') AND COALESCE(h.deduction_rate, 0) <> 0 AND u.charged_credits IS DISTINCT FROM h.deduction_rate)
          OR (h.llm_billing_snapshot IS NOT NULL AND NOT (u.quote ? 'snapshot')))
    )
    UPDATE billing.usage_charges u SET
      quoted_credits = COALESCE(u.quoted_credits, l.llm_intended_deduction),
      settled_at = COALESCE(u.settled_at, l.llm_billing_settled_at),
      status = CASE
        WHEN u.quote ? 'charge' THEN u.status
        WHEN COALESCE(u.settled_at, l.llm_billing_settled_at) IS NULL THEN u.status
        WHEN l.status = 'success' THEN 'free'
        ELSE 'failed'
      END,
      charged_credits = CASE WHEN u.quote ? 'charge' THEN u.charged_credits ELSE COALESCE(l.deduction_rate, u.charged_credits) END,
      quote = CASE WHEN u.quote ? 'snapshot' OR l.llm_billing_snapshot IS NULL THEN u.quote
                   ELSE u.quote || jsonb_build_object('snapshot', l.llm_billing_snapshot) END,
      updated_at = now()
    FROM lost l WHERE u.id = l.llm_charge_id
  $q$;
  GET DIAGNOSTICS v_healed = ROW_COUNT;

  -- 2. 没有计费编号、扣过星尘的老轮次（7 月、9 月）：补计费行（historical）并写回编号，展示的每轮星尘不变。
  --    有报价快照且 usage_charges 已有那一行（旧扣费记录迁来、没关联轮次）的，直接关联那一行。
  FOR r IN EXECUTE $q$
    SELECT h.id, h.user_id, h.status, h.created_at, h.deduction_rate, h.llm_intended_deduction, h.llm_billing_settled_at,
      h.llm_billing_snapshot,
      CASE WHEN h.llm_billing_snapshot ->> 'charge_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (h.llm_billing_snapshot ->> 'charge_id')::uuid END AS snapshot_charge_id
    FROM experience.chat_history h
    WHERE h.llm_charge_id IS NULL AND (h.deduction_rate > 0 OR h.llm_billing_snapshot IS NOT NULL)
    ORDER BY h.created_at, h.id
  $q$ LOOP
    v_existing := NULL;
    IF r.snapshot_charge_id IS NOT NULL THEN
      SELECT * INTO v_existing FROM billing.usage_charges WHERE id = r.snapshot_charge_id FOR UPDATE;
    END IF;
    IF v_existing.id IS NOT NULL THEN
      IF v_existing.user_id <> r.user_id OR (v_existing.subject_id IS NOT NULL AND v_existing.subject_id <> r.id) THEN
        RAISE EXCEPTION 'p6b1c-turn-billing: charge % belongs to another user or turn than turn %', v_existing.id, r.id;
      END IF;
      IF r.deduction_rate > 0 AND v_existing.charged_credits <> r.deduction_rate THEN
        RAISE EXCEPTION 'p6b1c-turn-billing: turn % charged % but its charge % holds %', r.id, r.deduction_rate, v_existing.id, v_existing.charged_credits;
      END IF;
      UPDATE billing.usage_charges u SET
        subject_id = r.id,
        quote = CASE WHEN u.quote ? 'snapshot' OR r.llm_billing_snapshot IS NULL THEN u.quote
                     ELSE u.quote || jsonb_build_object('snapshot', r.llm_billing_snapshot) END,
        updated_at = now()
      WHERE u.id = v_existing.id;
      v_id := v_existing.id;
    ELSE
      -- 快照里的编号就是这一轮当时的计费编号（新表里没有这一行时沿用它，没有快照的老轮次才新生成）。
      v_id := COALESCE(r.snapshot_charge_id, gen_random_uuid());
      INSERT INTO billing.usage_charges
        (id, user_id, kind, subject_id, status, quoted_credits, charged_credits, quote, settled_at, created_at, updated_at)
      VALUES (v_id, r.user_id, 'chat_text', r.id,
        CASE WHEN r.deduction_rate > 0 THEN 'historical' WHEN r.status = 'success' THEN 'free' ELSE 'failed' END,
        r.llm_intended_deduction, GREATEST(COALESCE(r.deduction_rate, 0), 0),
        jsonb_build_object('legacy', 'no_charge_id')
          || CASE WHEN r.llm_billing_snapshot IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('snapshot', r.llm_billing_snapshot) END,
        r.llm_billing_settled_at, r.created_at, now());
    END IF;
    IF r.deduction_rate > 0 THEN
      -- 只给扣过星尘的轮次写回编号（展示要读到实扣）；失败轮次照旧没有编号，计费行经 subject_id 指回轮次。
      UPDATE experience.chat_history SET llm_charge_id = v_id WHERE id = r.id AND llm_charge_id IS NULL;
      v_linked := v_linked + 1;
    ELSE
      v_snapshots := v_snapshots + 1;
    END IF;
  END LOOP;

  -- 3. 超过结算窗口（后端补结算只看 24 小时内开始的轮次）还停在 quoted、没有扣费明细的报价：给结束状态。
  --    交付成功但没扣上（余额不足）记 waived，其余（失败轮、开轮后编号被清掉的报价）记 failed，实扣都是 0。
  UPDATE billing.usage_charges u SET
    status = CASE WHEN EXISTS (SELECT 1 FROM experience.chat_history h WHERE h.llm_charge_id = u.id AND h.status = 'success')
                  THEN 'waived' ELSE 'failed' END,
    settled_at = now(),
    quote = u.quote || jsonb_build_object('legacy', 'stale_quote'),
    updated_at = now()
  WHERE u.kind = 'chat_text' AND u.status = 'quoted' AND NOT (u.quote ? 'charge') AND u.charged_credits = 0
    AND u.created_at < now() - interval '25 hours'
    AND NOT EXISTS (SELECT 1 FROM experience.chat_history h WHERE h.llm_charge_id = u.id AND h.status = 'streaming');
  GET DIAGNOSTICS v_closed = ROW_COUNT;

  RAISE NOTICE 'p6b1c-turn-billing: healed % lost writes, linked % legacy paid turns, kept % failed-turn quotes, closed % stale quotes',
    v_healed, v_linked, v_snapshots, v_closed;
END
$legacy$;

DO $readers$
DECLARE
  v_fn regprocedure := 'analytics.refresh_core_daily(date)'::regprocedure;
  v_def text;
  v_day date := (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date - 1;
  v_before jsonb;
  v_after jsonb;
  v_view regclass;
  v_from text;
  v_opts text;
  n_old int;
  c_rate constant text := 'COALESCE(u.charged_credits,h.deduction_rate) AS deduction_rate';
  c_rate_new constant text := 'u.charged_credits AS deduction_rate';
  c_note constant text := '-- 实扣星尘取每轮扣费额（与钱包流水 chat_debit 逐日一致）；扣费记录每用户只留 100 条，不能作来源';
  c_note_new constant text := '-- 实扣星尘取 billing.usage_charges.charged_credits（与钱包流水 chat_debit 逐日一致）';
BEGIN
  -- 看板日汇总：新旧函数各刷一遍昨天，结果相同才保留新函数（不同就整块回滚）。
  SELECT pg_get_functiondef(v_fn) INTO v_def;
  IF position('h.deduction_rate) AS deduction_rate' IN v_def) > 0 THEN
    n_old := (length(v_def) - length(replace(v_def, c_rate, ''))) / length(c_rate);
    IF n_old <> 1 THEN RAISE EXCEPTION 'p6b1c-turn-billing: refresh_core_daily rate anchor found % times, expected 1', n_old; END IF;
    FOR i IN 1..30 LOOP
      EXIT WHEN analytics.refresh_core_daily(v_day);
      IF i = 30 THEN RAISE EXCEPTION 'p6b1c-turn-billing: core_daily refresh stayed busy'; END IF;
      PERFORM pg_sleep(2);
    END LOOP;
    SELECT jsonb_agg(to_jsonb(d) - 'refreshed_at' ORDER BY d.metric_scope, d.model_id) INTO v_before
    FROM analytics.core_daily d WHERE d.metric_date = v_day;
    v_def := replace(v_def, c_rate, c_rate_new);
    IF position(c_note IN v_def) > 0 THEN v_def := replace(v_def, c_note, c_note_new); END IF;
    EXECUTE v_def;
    PERFORM analytics.refresh_core_daily(v_day);
    SELECT jsonb_agg(to_jsonb(d) - 'refreshed_at' ORDER BY d.metric_scope, d.model_id) INTO v_after
    FROM analytics.core_daily d WHERE d.metric_date = v_day;
    IF v_before IS DISTINCT FROM v_after THEN
      RAISE EXCEPTION 'p6b1c-turn-billing: core_daily for % differs after the switch', v_day;
    END IF;
    RAISE NOTICE 'p6b1c-turn-billing: core_daily % identical (% rows)', v_day, jsonb_array_length(COALESCE(v_after, '[]'));
  END IF;

  -- 两个展示视图：每轮星尘只取 usage_charges（输出列名、类型、视图选项不变）。替换视图要拿视图排他锁，
  -- 会话统计触发器也读它：等锁上限 1 秒、重试，不让后端 5 秒超时的写入排在后面。
  FOR v_view, v_from IN
    SELECT * FROM (VALUES
      ('experience.chat_history_display'::regclass, 'COALESCE(uc.charged_credits, h.deduction_rate)'),
      ('experience.session_chat_history'::regclass, 'COALESCE(uc.charged_credits, c.deduction_rate)')) AS v(view_name, anchor)
  LOOP
    v_def := pg_get_viewdef(v_view);
    n_old := (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from);
    CONTINUE WHEN n_old = 0 AND position('deduction_rate)' IN v_def) = 0;
    IF n_old <> 1 THEN RAISE EXCEPTION 'p6b1c-turn-billing: % rate anchor found % times, expected 1', v_view, n_old; END IF;
    v_def := regexp_replace(replace(v_def, v_from, 'uc.charged_credits'), ';\s*$', '');
    SELECT array_to_string(c.reloptions, ', ') INTO v_opts FROM pg_class c WHERE c.oid = v_view;
    FOR i IN 1..30 LOOP
      BEGIN
        PERFORM set_config('lock_timeout', '1s', true);
        EXECUTE format('CREATE OR REPLACE VIEW %s %s AS %s', v_view,
          CASE WHEN v_opts IS NULL THEN '' ELSE 'WITH (' || v_opts || ')' END, v_def);
        EXIT;
      EXCEPTION WHEN lock_not_available THEN
        IF i = 30 THEN RAISE; END IF;
        PERFORM pg_sleep(1);
      END;
    END LOOP;
  END LOOP;
  PERFORM set_config('lock_timeout', '0', true);
  RAISE NOTICE 'p6b1c-turn-billing: readers no longer fall back to chat_history.deduction_rate';
END
$readers$;

DO $columns$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'experience' AND table_name = 'chat_history'
                   AND column_name IN ('deduction_rate', 'llm_billing_snapshot', 'llm_billing_settled_at', 'llm_intended_deduction')) THEN
    RAISE NOTICE 'p6b1c-turn-billing: billing columns already dropped';
    RETURN;
  END IF;
  -- 删列要轮次表排他锁：等锁上限 1 秒（短于后端 5 秒超时）、重试；拿到后只做元数据改动。
  FOR i IN 1..30 LOOP
    BEGIN
      PERFORM set_config('lock_timeout', '1s', true);
      LOCK TABLE experience.chat_history IN ACCESS EXCLUSIVE MODE;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF i = 30 THEN RAISE; END IF;
      PERFORM pg_sleep(2);
    END;
  END LOOP;
  DROP TRIGGER IF EXISTS trg_mirror_chat_history_charge ON experience.chat_history;
  ALTER TABLE experience.chat_history
    DROP COLUMN IF EXISTS deduction_rate,
    DROP COLUMN IF EXISTS llm_billing_snapshot,
    DROP COLUMN IF EXISTS llm_billing_settled_at,
    DROP COLUMN IF EXISTS llm_intended_deduction;
  RAISE NOTICE 'p6b1c-turn-billing: dropped the mirror trigger and 4 billing columns from chat_history';
END
$columns$;

DO $old_tables$
DECLARE
  v_charges bigint := 0;
  v_dedup bigint := 0;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  IF to_regclass('billing.llm_usage_charges') IS NOT NULL THEN
    SELECT count(*) INTO v_charges FROM billing.llm_usage_charges;
    DROP FUNCTION IF EXISTS billing.grant_character_creator_reward(billing.llm_usage_charges);
    DROP TABLE billing.llm_usage_charges;
  END IF;
  IF to_regclass('billing.llm_usage_charge_dedup') IS NOT NULL THEN
    SELECT count(*) INTO v_dedup FROM billing.llm_usage_charge_dedup;
    DROP TABLE billing.llm_usage_charge_dedup;
  END IF;
  DROP FUNCTION IF EXISTS billing.tf_mirror_llm_usage_charge();
  DROP FUNCTION IF EXISTS billing.prepare_llm_usage_charge();
  DROP FUNCTION IF EXISTS billing.retain_recent_llm_usage_charges();
  DROP FUNCTION IF EXISTS billing.tf_mirror_chat_history_charge();
  RAISE NOTICE 'p6b1c-turn-billing: dropped llm_usage_charges (% rows), llm_usage_charge_dedup (% rows) and their functions',
    v_charges, v_dedup;
END
$old_tables$;

DO $check$
DECLARE
  v_bad text;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'experience' AND table_name = 'chat_history'
               AND column_name IN ('deduction_rate', 'llm_billing_snapshot', 'llm_billing_settled_at', 'llm_intended_deduction')) THEN
    RAISE EXCEPTION 'p6b1c-turn-billing: chat_history still has billing columns';
  END IF;
  IF to_regclass('billing.llm_usage_charges') IS NOT NULL OR to_regclass('billing.llm_usage_charge_dedup') IS NOT NULL THEN
    RAISE EXCEPTION 'p6b1c-turn-billing: old charge tables still exist';
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND p.prosrc ~ '(llm_billing_snapshot|llm_billing_settled_at|llm_intended_deduction|h\.deduction_rate\)|c\.deduction_rate\))'
    -- 反馈函数把 usage_charges 的快照取别名为 llm_billing_snapshot，不是读旧列
    AND n.nspname || '.' || p.proname <> 'experience.save_chat_reply_feedback';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'p6b1c-turn-billing: functions still read the dropped columns: %', v_bad;
  END IF;
  -- 看板函数删列后仍能跑（今天这一格由定时任务每 30 分钟重刷）。
  PERFORM analytics.refresh_core_daily((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date);
  RAISE NOTICE 'p6b1c-turn-billing: contract complete';
END
$check$;

NOTIFY pgrst, 'reload schema';
