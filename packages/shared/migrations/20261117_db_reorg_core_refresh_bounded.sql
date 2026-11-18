-- Domain: miniapp_analytics（派生 D）——经营看板日汇总：刷新提速，今天/昨天拆成两个任务。
-- 数据库重组阶段 2a，计划见 .trellis/tasks/11-17-db-reorg-p2-observability/design.md。
--
-- 问题（2026-11-17 生产实测）：cron grafana_core_recent_30m 每 30 分钟在同一条命令里刷新今天和昨天，
-- 每条语句 5s 超时，两条同一事务，任一条超时会连另一条一起回滚。函数对当天每条聊天记录逐行随机查
-- openrouter/venice 明细表和计费表，磁盘读约 1ms/块，当天 4533 行耗时 5.8s。11-17 午后 8 次失败 6 次。
-- 改动：
--   1. 函数同签名、同输出、同权限。两张供应商明细表先按 created_at 取窗口 [当天 00:00 - 5 分钟, 次日 01:00)，
--      物化后与当天聊天记录哈希配对，不再逐行随机查。生产实测明细行比聊天记录晚 0~111 秒写入、从不更早；
--      chat_history_id 在两表唯一，结果与逐行查一致。计费表仍按 charge_key 查（阶段 6 取代）。
--   2. grafana_core_recent_30m 只刷新今天（20s 上限）；新增 grafana_core_yesterday_close 在北京时间
--      00:17~06:17 每小时刷新一次昨天（30s 上限），收尾跨零点结算。两个任务互不连坐。
-- Verify: bash scripts/test-db-reorg-p2a-migration.sh（PG17 非超级用户：新旧函数在随机合成数据上逐行一致、
--   两次幂等、cron 命令与时间、权限不扩大、无 pg_cron 时只装函数）。
-- Release: TEST -> Production。无应用代码改动。
-- Recovery: 重新执行 20261026_grafana_light_core.sql 的函数与 cron 段即回到旧行为；汇总表是派生缓存，可随时重算。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

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
  DELETE FROM miniapp_analytics.grafana_core_daily WHERE metric_date=p_day;
  WITH day_history AS MATERIALIZED (
    SELECT id,user_id,llm_charge_id,model,
      llm_billing_snapshot->>'model_id' AS selected_model_id,
      llm_billing_snapshot->>'model_display_name' AS selected_model_name
    FROM experience.chat_history
    WHERE created_at>=v_start AND created_at<v_end AND status<>'insufficient_balance'
  ), day_openrouter AS MATERIALIZED (
    -- 明细行在聊天记录之后写入；窗口两端各留余量，按 created_at 索引取一段再哈希配对。
    SELECT chat_history_id,usage FROM experience.openrouter_chat_history
    WHERE created_at>=v_start-interval '5 minutes' AND created_at<v_end+interval '1 hour'
  ), day_venice AS MATERIALIZED (
    SELECT chat_history_id,llm_usage FROM experience.venice_chat_history
    WHERE created_at>=v_start-interval '5 minutes' AND created_at<v_end+interval '1 hour'
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
    LEFT JOIN day_openrouter o ON o.chat_history_id=h.id
    LEFT JOIN day_venice v ON v.chat_history_id=h.id
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

DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron unavailable: function updated, no scheduler configured';
    RETURN;
  END IF;
  -- cron.schedule 按 jobname 覆盖已有任务；GMT 时区。
  PERFORM cron.schedule('grafana_core_recent_30m','7,37 * * * *',
    $job$SET statement_timeout='20s'; SET lock_timeout='1s'; SET max_parallel_workers_per_gather=0;
SELECT miniapp_analytics.refresh_grafana_core_day((now() AT TIME ZONE 'Asia/Shanghai')::date);$job$);
  PERFORM cron.schedule('grafana_core_yesterday_close','17 16-22 * * *',
    $job$SET statement_timeout='30s'; SET lock_timeout='1s'; SET max_parallel_workers_per_gather=0;
SELECT miniapp_analytics.refresh_grafana_core_day((now() AT TIME ZONE 'Asia/Shanghai')::date-1);$job$);
END
$cron$;

COMMIT;
