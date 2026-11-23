-- Domain: miniapp_analytics / experience（文本扣费的读方）——数据库重组阶段 6b-1c 写方切换（一）：看板日汇总、交付函数改读 billing.usage_charges。
-- 计划见 .trellis/tasks/11-19-db-reorg-p6-billing/design.md（6b-1c 第二步：写方切换拆解）。
--
-- miniapp_analytics.refresh_grafana_core_day：
--   - 每轮扣费额、报价里的模型、扣费明细里的模型改读 usage_charges，不再关联旧扣费表 billing.llm_usage_charges；
--   - 没有计费编号的失败轮次（失败收尾清了编号），用户选的模型取 chat_generation_requests.requested_model_id
--     （11-21 生产：近 14 天 82 轮全部有请求，与原报价快照逐条相同）；
--   - 显示名只取有报价的行，避免这类轮次的上游模型名混进标签；
--   - 成本去掉旧扣费表兜底（近 14 天 0 次生效）。
--   生产只读模拟：近 14 天 243 个"日期 × 模型"分组，新旧口径逐项相同。
-- experience.select_chat_generation_delivery：
--   - "计费身份已登记"的守卫改为：轮次有编号，且 usage_charges 这一行报价里的编号一致
--     （旧写法在编号为空时也拒绝；近 30 天交付过却没有编号的轮次 0）；
--   - 交付时写供应商仍写快照列，由镜像同步到新表，写方切换第 3 步再改。
-- 本文件（一个事务）：
--   1. 用旧函数刷新昨天的看板并记下结果；
--   2. 按原文 md5 守卫、锚点恰好命中、核对结果 md5 替换两个函数（已是新版本跳过）；
--   3. 用新函数再刷新昨天，两次结果（除刷新时间）不同就整体回滚。
--   替换函数不锁业务表；lock_timeout 1 秒。看板刷新正被定时任务占用时报错，稍后按原文件重跑。
--
-- Verify: bash scripts/test-db-reorg-p6b1c-grafana-delivery.sh
-- Release: TEST -> Production（不需要后端发布）。回滚：锚点互换反向替换。

CREATE OR REPLACE FUNCTION billing.p6b1c_patch_function(p_fn regprocedure, p_from text, p_to text, p_edits text[])
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
    RAISE EXCEPTION 'p6b1c-readers: % drifted (md5 %), refusing', p_fn, v_md5;
  END IF;
  v_def := pg_get_functiondef(p_fn);
  FOR i IN 1 .. array_length(p_edits, 1) / 3 LOOP
    v_old := p_edits[3 * i - 2];
    v_count := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    IF v_count <> p_edits[3 * i]::int THEN
      RAISE EXCEPTION 'p6b1c-readers: % anchor % found % times, expected %', p_fn, i, v_count, p_edits[3 * i];
    END IF;
    v_def := replace(v_def, v_old, p_edits[3 * i - 1]);
  END LOOP;
  EXECUTE v_def;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = p_fn;
  IF v_md5 <> p_to THEN
    RAISE EXCEPTION 'p6b1c-readers: % has md5 % after the patch', p_fn, v_md5;
  END IF;
  RETURN format('%s now reads usage_charges', p_fn);
END
$fn$;

DO $patch$
DECLARE
  v_day date := (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date - 1;
  v_before jsonb;
  v_after jsonb;
BEGIN
  SET LOCAL lock_timeout = '1s';
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'miniapp_analytics.refresh_grafana_core_day(date)'::regprocedure) = '11ea797699ac67b5a2f61162bc153075' THEN
    IF NOT miniapp_analytics.refresh_grafana_core_day(v_day) THEN
      RAISE EXCEPTION 'p6b1c-readers: grafana refresh is busy, rerun this file later';
    END IF;
    SELECT jsonb_agg(to_jsonb(d) - 'refreshed_at' ORDER BY d.metric_scope, d.model_id) INTO v_before
    FROM miniapp_analytics.grafana_core_daily d WHERE d.metric_date = v_day;
  END IF;
  RAISE NOTICE 'p6b1c-readers: %', billing.p6b1c_patch_function(
    'miniapp_analytics.refresh_grafana_core_day(date)'::regprocedure,
    '11ea797699ac67b5a2f61162bc153075', '0e0dd2f50318bbe6675d7be23b8c72db',
    ARRAY[
      $o1$    SELECT id,user_id,llm_charge_id,model,deduction_rate,
      llm_billing_snapshot->>'model_id' AS selected_model_id,
      llm_billing_snapshot->>'model_display_name' AS selected_model_name
    FROM experience.chat_history
    WHERE created_at>=v_start AND created_at<v_end AND status<>'insufficient_balance'
$o1$,
      $n1$    -- db reorg 6b-1c：报价与扣费明细在 billing.usage_charges。没有计费编号的失败轮次，用户选的模型取开轮请求
    -- （与原报价快照逐条相同）；显示名只取有报价的行，避免上游模型名混进标签。
    SELECT h.id,h.user_id,h.llm_charge_id,h.model,
      COALESCE(u.charged_credits,h.deduction_rate) AS deduction_rate,
      CASE WHEN h.llm_charge_id IS NULL THEN r.requested_model_id ELSE u.quote->'snapshot'->>'model_id' END AS selected_model_id,
      u.quote->'snapshot'->>'model_display_name' AS selected_model_name,
      u.quote->'charge'->>'model_id' AS charge_model_id,
      u.quote->'charge'->>'model_display_name' AS charge_model_name
    FROM experience.chat_history h
    LEFT JOIN billing.usage_charges u ON u.id=h.llm_charge_id
    LEFT JOIN experience.chat_generation_requests r ON r.chat_history_id=h.id
    WHERE h.created_at>=v_start AND h.created_at<v_end AND h.status<>'insufficient_balance'
$n1$,
      '1',
      $o2$      COALESCE(NULLIF(h.selected_model_id,''),NULLIF(c.model_id,''),NULLIF(h.model,''),'unknown') AS model_id,
      COALESCE(NULLIF(h.selected_model_name,''),NULLIF(c.model_display_name,''),NULLIF(h.model,''),'unknown') AS model_name,
$o2$,
      $n2$      COALESCE(NULLIF(h.selected_model_id,''),NULLIF(h.charge_model_id,''),NULLIF(h.model,''),'unknown') AS model_id,
      COALESCE(NULLIF(h.selected_model_name,''),NULLIF(h.charge_model_name,''),NULLIF(h.model,''),'unknown') AS model_name,
      (NULLIF(h.selected_model_name,'') IS NOT NULL OR NULLIF(h.charge_model_name,'') IS NOT NULL) AS named_by_quote,
$n2$,
      '1',
      $o3$        ELSE COALESCE(o.cost_usd, c.usage_cost_usd) END AS cost_usd
$o3$,
      $n3$        ELSE o.cost_usd END AS cost_usd
$n3$,
      '1',
      $o4$    LEFT JOIN billing.llm_usage_charges c ON c.charge_key=h.llm_charge_id
$o4$,
      $n4$$n4$,
      '1',
      $o5$ELSE max(model_name) END,$o5$,
      $n5$ELSE COALESCE(max(model_name) FILTER (WHERE named_by_quote),max(model_name)) END,$n5$,
      '1']);
  RAISE NOTICE 'p6b1c-readers: %', billing.p6b1c_patch_function(
    'experience.select_chat_generation_delivery(uuid,uuid,text)'::regprocedure,
    '8a876c2ed31463dded90de7850b2eadd', '328ec8a612f0ad05fc00351d1fada03f',
    ARRAY[
      $o1$OR h.llm_billing_snapshot->>'charge_id' IS DISTINCT FROM h.llm_charge_id::text THEN$o1$,
      $n1$OR h.llm_charge_id IS NULL
     -- db reorg 6b-1c: the accepted quote lives in billing.usage_charges.
     OR (SELECT u.quote->'snapshot'->>'charge_id' FROM billing.usage_charges u WHERE u.id=h.llm_charge_id)
        IS DISTINCT FROM h.llm_charge_id::text THEN$n1$,
      '1']);
  IF v_before IS NOT NULL THEN
    IF NOT miniapp_analytics.refresh_grafana_core_day(v_day) THEN
      RAISE EXCEPTION 'p6b1c-readers: grafana refresh is busy, rerun this file later';
    END IF;
    SELECT jsonb_agg(to_jsonb(d) - 'refreshed_at' ORDER BY d.metric_scope, d.model_id) INTO v_after
    FROM miniapp_analytics.grafana_core_daily d WHERE d.metric_date = v_day;
    IF v_after IS DISTINCT FROM v_before THEN
      RAISE EXCEPTION 'p6b1c-readers: % grafana rows changed after the switch, rolling back', v_day;
    END IF;
    RAISE NOTICE 'p6b1c-readers: % grafana rows identical before and after (% rows)', v_day, jsonb_array_length(v_after);
  END IF;
END
$patch$;

DROP FUNCTION billing.p6b1c_patch_function(regprocedure, text, text, text[]);
