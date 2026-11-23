CREATE OR REPLACE FUNCTION analytics.refresh_core_daily(p_day date)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_today date := (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date;
  v_start timestamptz;
  v_end timestamptz;
BEGIN
  IF p_day IS NULL OR p_day<v_today-13 OR p_day>v_today THEN
    RAISE EXCEPTION 'Only one day within the last 14 days is refreshable';
  END IF;
  IF NOT pg_try_advisory_xact_lock(20261026,510) THEN RETURN false; END IF;
  v_start := p_day::timestamp AT TIME ZONE 'Asia/Shanghai';
  v_end := (p_day+1)::timestamp AT TIME ZONE 'Asia/Shanghai';
  DELETE FROM analytics.core_daily WHERE metric_date=p_day;
  WITH day_history AS MATERIALIZED (
    -- db reorg 6b-1c：报价与扣费明细在 billing.usage_charges。没有计费编号的失败轮次，用户选的模型取开轮请求
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
  ), day_calls AS MATERIALIZED (
    -- 每轮成本 = 首发 + 兜底全部上游调用（三家供应商，统一美元），与 analytics.llm_turn_costs 同口径。
    -- 按当天轮次 id 关联（扩展迁移补建的行 created_at 不是轮次时间）；还有调用在等成本补查的轮次先不算已记录成本。
    SELECT l.chat_history_id,
      sum(COALESCE(l.cost_usd,0)) FILTER (WHERE l.cost_source IS NOT NULL) AS cost_usd,
      bool_or(l.cost_source IS NULL AND l.dispatched_at IS NOT NULL) AS cost_pending
    FROM ops.llm_calls l
    WHERE l.chat_history_id IN (SELECT id FROM day_history)
    GROUP BY l.chat_history_id
  ), facts AS MATERIALIZED (
    SELECT h.user_id,
      COALESCE(NULLIF(h.selected_model_id,''),NULLIF(h.charge_model_id,''),NULLIF(h.model,''),'unknown') AS model_id,
      COALESCE(NULLIF(h.selected_model_name,''),NULLIF(h.charge_model_name,''),NULLIF(h.model,''),'unknown') AS model_name,
      (NULLIF(h.selected_model_name,'') IS NOT NULL OR NULLIF(h.charge_model_name,'') IS NOT NULL) AS named_by_quote,
      -- 实扣星尘取每轮扣费额（与钱包流水 chat_debit 逐日一致）；扣费记录每用户只留 100 条，不能作来源
      GREATEST(COALESCE(h.deduction_rate,0),0) AS stars,
      CASE WHEN o.cost_pending THEN NULL
        ELSE o.cost_usd END AS cost_usd
    FROM day_history h
    LEFT JOIN day_calls o ON o.chat_history_id=h.id
  )
  INSERT INTO analytics.core_daily
    (metric_date,metric_scope,model_id,model_name,requests,chat_users,
     charged_requests,charged_stars,known_cost_requests,recorded_cost_usd,refreshed_at)
  SELECT p_day,CASE WHEN grouping(model_id)=1 THEN 'overall' ELSE 'model' END,
    CASE WHEN grouping(model_id)=1 THEN '__all__' ELSE model_id END,
    CASE WHEN grouping(model_id)=1 THEN '全部型号' ELSE COALESCE(max(model_name) FILTER (WHERE named_by_quote),max(model_name)) END,
    count(*),count(DISTINCT user_id),count(*) FILTER(WHERE stars>0),COALESCE(sum(stars),0),
    count(*) FILTER(WHERE cost_usd>=0),sum(cost_usd) FILTER(WHERE cost_usd>=0),clock_timestamp()
  FROM facts GROUP BY GROUPING SETS ((model_id),());

  UPDATE analytics.core_daily d SET
    paid_orders=p.orders,paying_users=p.users,cash_cny=p.cash
  FROM (
    SELECT count(*) AS orders,count(DISTINCT user_id) AS users,
      COALESCE(sum(amount_cents),0)::numeric/100 AS cash
    FROM billing.payment_orders
    WHERE status='completed' AND paid_at>=v_start AND paid_at<v_end
  ) p WHERE d.metric_date=p_day AND d.metric_scope='overall';
  DELETE FROM analytics.core_daily WHERE metric_date<v_today-13;
  RETURN true;
END;
$function$
