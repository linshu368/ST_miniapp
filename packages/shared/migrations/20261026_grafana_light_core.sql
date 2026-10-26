-- domain: miniapp_analytics
-- Derived, aggregate-only operating cache. Runtime/billing never consumes it.
-- Replace eleven full-history refreshes with one bounded recent-day job.
-- No source rows or old materialized data are deleted. No bootstrap in this DDL.
-- Apply TEST then production; refresh one day with a caller-side 5s timeout before
-- enabling the new job. Recovery: disable new job; preserve cache/source data.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE TABLE IF NOT EXISTS miniapp_analytics.grafana_core_daily (
  metric_date date NOT NULL,
  metric_scope text NOT NULL CHECK(metric_scope IN ('overall','model')),
  model_id text NOT NULL,
  model_name text NOT NULL,
  requests bigint NOT NULL,
  chat_users bigint NOT NULL,
  charged_requests bigint NOT NULL,
  charged_stars numeric NOT NULL,
  known_cost_requests bigint NOT NULL,
  recorded_cost_usd numeric,
  paid_orders bigint,
  paying_users bigint,
  cash_cny numeric,
  refreshed_at timestamptz NOT NULL,
  PRIMARY KEY(metric_date,metric_scope,model_id),
  CHECK((metric_scope='overall' AND model_id='__all__') OR
        (metric_scope='model' AND model_id<>'__all__')),
  CHECK(known_cost_requests<=requests AND chat_users<=requests)
);
COMMENT ON TABLE miniapp_analytics.grafana_core_daily IS
 '14-day aggregate reporting cache; overall distinct users must not be summed across models/days. Recorded request cost is incomplete and may exclude discarded upstream attempts.';
ALTER TABLE miniapp_analytics.grafana_core_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp_analytics.grafana_core_daily FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA miniapp_analytics TO first_token_metrics_reader;
GRANT SELECT ON miniapp_analytics.grafana_core_daily TO first_token_metrics_reader;
DROP POLICY IF EXISTS grafana_core_read ON miniapp_analytics.grafana_core_daily;
CREATE POLICY grafana_core_read ON miniapp_analytics.grafana_core_daily
 FOR SELECT TO first_token_metrics_reader USING(true);

CREATE OR REPLACE FUNCTION miniapp_analytics.refresh_grafana_core_day(p_day date)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
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
  -- Only a time-indexed day enters enrichment. No all-history dedup/window,
  -- ledger aggregation, user lifecycle segmentation or raw provider JSON payload.
  DELETE FROM miniapp_analytics.grafana_core_daily WHERE metric_date=p_day;
  WITH day_history AS MATERIALIZED (
    SELECT id,user_id,llm_charge_id,model,
      llm_billing_snapshot->>'model_id' AS selected_model_id,
      llm_billing_snapshot->>'model_display_name' AS selected_model_name
    FROM experience.chat_history
    WHERE created_at>=v_start AND created_at<v_end AND status<>'insufficient_balance'
  ), facts AS MATERIALIZED (
    SELECT h.user_id,
      COALESCE(NULLIF(h.selected_model_id,''),NULLIF(c.model_id,''),NULLIF(h.model,''),'unknown') AS model_id,
      COALESCE(NULLIF(h.selected_model_name,''),NULLIF(c.model_display_name,''),NULLIF(h.model,''),'unknown') AS model_name,
      CASE WHEN c.status IN ('charged','partial','reconciled','historical')
        THEN GREATEST(COALESCE(c.charged_amount,0),0) ELSE 0 END AS stars,
      COALESCE(c.usage_cost_usd,
        CASE WHEN jsonb_typeof(o.usage)='number' THEN (o.usage#>>'{}')::numeric END,
        CASE WHEN jsonb_typeof(v.llm_usage)='number' THEN (v.llm_usage#>>'{}')::numeric/1000000 END) AS cost_usd
    FROM day_history h
    LEFT JOIN billing.llm_usage_charges c ON c.charge_key=h.llm_charge_id
    LEFT JOIN experience.openrouter_chat_history o ON o.chat_history_id=h.id
    LEFT JOIN experience.venice_chat_history v ON v.chat_history_id=h.id
  )
  INSERT INTO miniapp_analytics.grafana_core_daily
    (metric_date,metric_scope,model_id,model_name,requests,chat_users,
     charged_requests,charged_stars,known_cost_requests,recorded_cost_usd,refreshed_at)
  SELECT p_day,CASE WHEN grouping(model_id)=1 THEN 'overall' ELSE 'model' END,
    CASE WHEN grouping(model_id)=1 THEN '__all__' ELSE model_id END,
    CASE WHEN grouping(model_id)=1 THEN '全部型号' ELSE max(model_name) END,
    count(*),count(DISTINCT user_id),count(*) FILTER(WHERE stars>0),COALESCE(sum(stars),0),
    count(*) FILTER(WHERE cost_usd>=0),sum(cost_usd) FILTER(WHERE cost_usd>=0),clock_timestamp()
  FROM facts GROUP BY GROUPING SETS ((model_id),());

  UPDATE miniapp_analytics.grafana_core_daily d SET
    paid_orders=p.orders,paying_users=p.users,cash_cny=p.cash
  FROM (
    SELECT count(*) AS orders,count(DISTINCT user_id) AS users,
      COALESCE(sum(amount_cents),0)::numeric/100 AS cash
    FROM billing.payment_orders
    WHERE status='completed' AND paid_at>=v_start AND paid_at<v_end
  ) p WHERE d.metric_date=p_day AND d.metric_scope='overall';
  DELETE FROM miniapp_analytics.grafana_core_daily WHERE metric_date<v_today-13;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION miniapp_analytics.refresh_grafana_core_day(date)
 FROM PUBLIC,anon,authenticated,first_token_metrics_reader;

DO $$
DECLARE v_job record; v_id bigint;
BEGIN
  -- Retire, rather than merely pause, the old full-history scheduled work.
  -- Existing objects and their historical cached data remain intact.
  FOR v_job IN SELECT jobid FROM cron.job WHERE jobname IN (
    'grafana_cache_billing_hourly','grafana_cache_user_distribution_hourly',
    'grafana_cache_business_hourly','grafana_cache_funnel_6h',
    'grafana_cache_user_ecosystem_6h','grafana_cache_cohort_ltv_6h',
    'grafana_strategy_model_daily_6h','grafana_free_quota_daily_6h',
    'grafana_purchase_repeat_daily_6h','grafana_llm_config_version_daily_6h',
    'grafana_card_unit_economics_30d_6h'
  ) LOOP PERFORM cron.unschedule(v_job.jobid); END LOOP;
  v_id := cron.schedule('grafana_core_recent_30m','7,37 * * * *',
    $job$SET statement_timeout='5s'; SET lock_timeout='1s'; SET max_parallel_workers_per_gather=0;
SELECT miniapp_analytics.refresh_grafana_core_day((now() AT TIME ZONE 'Asia/Shanghai')::date);
SELECT miniapp_analytics.refresh_grafana_core_day((now() AT TIME ZONE 'Asia/Shanghai')::date-1);$job$);
  -- A repeat apply preserves an already-enabled job; the first apply waits for
  -- production smoke/bootstrap and dashboard validation before activation.
  IF NOT EXISTS(SELECT 1 FROM miniapp_analytics.grafana_core_daily) THEN
    PERFORM cron.alter_job(v_id,active:=false);
  END IF;
END;
$$;
COMMIT;
