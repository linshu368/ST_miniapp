-- 043: Read-only analytics RPCs for the Admin platform.
-- No business tables or columns are added. All raw schemas remain private.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_chat_history_created_at
  ON miniapp.chat_history (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_orders_paid_at
  ON miniapp.payment_orders (paid_at DESC)
  WHERE paid_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_daily_checkins_claimed_at
  ON miniapp.daily_checkins (claimed_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_messages_created_at
  ON cs_platform.outreach_messages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_tasks_created_at
  ON st_infra.sync_tasks (created_at DESC);

CREATE OR REPLACE FUNCTION admin.analytics_require_access(p_details BOOLEAN DEFAULT false)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
BEGIN
  SELECT au.* INTO v_actor
  FROM admin.admin_users AS au
  WHERE au.user_id = auth.uid();

  IF NOT FOUND OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'admin analytics access required' USING ERRCODE = '42501';
  END IF;
  IF p_details AND v_actor.role = 'viewer' THEN
    RAISE EXCEPTION 'viewer cannot access identifiable analytics details'
      USING ERRCODE = '42501';
  END IF;
  RETURN v_actor.role;
END;
$$;

CREATE OR REPLACE FUNCTION admin.analytics_bucket(
  p_timestamp TIMESTAMPTZ,
  p_grain TEXT
) RETURNS TIMESTAMPTZ
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE p_grain
    WHEN 'hour' THEN date_trunc('hour', p_timestamp)
    WHEN 'week' THEN date_trunc('week', p_timestamp)
    WHEN 'month' THEN date_trunc('month', p_timestamp)
    ELSE date_trunc('day', p_timestamp)
  END
$$;

CREATE OR REPLACE FUNCTION admin.get_analytics_dashboard(
  p_section TEXT,
  p_from TIMESTAMPTZ DEFAULT (now() - interval '30 days'),
  p_to TIMESTAMPTZ DEFAULT now(),
  p_grain TEXT DEFAULT 'day'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_summary JSONB := '[]'::JSONB;
  v_charts JSONB := '[]'::JSONB;
  v_tables JSONB := '[]'::JSONB;
  v_notes JSONB := '[]'::JSONB;
  v_rows JSONB := '[]'::JSONB;
BEGIN
  PERFORM admin.analytics_require_access(false);
  IF p_section NOT IN (
    'overview', 'users', 'retention', 'chats', 'models', 'characters',
    'billing', 'checkins', 'growth', 'outreach', 'system'
  ) THEN
    RAISE EXCEPTION 'unsupported analytics section: %', p_section
      USING ERRCODE = '22023';
  END IF;
  IF p_grain NOT IN ('hour', 'day', 'week', 'month') THEN
    RAISE EXCEPTION 'unsupported analytics grain: %', p_grain USING ERRCODE = '22023';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to
     OR p_to - p_from > interval '366 days' THEN
    RAISE EXCEPTION 'analytics range must be positive and no longer than 366 days'
      USING ERRCODE = '22023';
  END IF;

  IF p_section = 'overview' THEN
    SELECT jsonb_build_array(
      jsonb_build_object('label', '新增用户', 'value', (SELECT count(*) FROM miniapp.users u WHERE u.created_at >= p_from AND u.created_at < p_to), 'unit', '人'),
      jsonb_build_object('label', '活跃用户', 'value', (SELECT count(DISTINCT h.user_id) FROM miniapp.chat_history h WHERE h.created_at >= p_from AND h.created_at < p_to), 'unit', '人'),
      jsonb_build_object('label', '成功对话', 'value', (SELECT count(*) FROM miniapp.chat_history h WHERE h.created_at >= p_from AND h.created_at < p_to AND h.status = 'success'), 'unit', '轮'),
      jsonb_build_object('label', '收入', 'value', COALESCE((SELECT sum(o.amount_cents) FROM miniapp.payment_orders o WHERE o.paid_at >= p_from AND o.paid_at < p_to AND o.status = 'completed'), 0), 'unit', '分'),
      jsonb_build_object('label', '付费人数', 'value', (SELECT count(DISTINCT o.user_id) FROM miniapp.payment_orders o WHERE o.paid_at >= p_from AND o.paid_at < p_to AND o.status = 'completed'), 'unit', '人'),
      jsonb_build_object('label', '签到', 'value', (SELECT count(*) FROM miniapp.daily_checkins d WHERE d.claimed_at >= p_from AND d.claimed_at < p_to), 'unit', '次'),
      jsonb_build_object('label', '回访回复', 'value', (SELECT count(*) FROM cs_platform.outreach_messages m WHERE m.received_at >= p_from AND m.received_at < p_to AND m.direction = 'user'), 'unit', '条'),
      jsonb_build_object('label', '同步完成', 'value', (SELECT count(*) FROM st_infra.sync_tasks s WHERE s.updated_at >= p_from AND s.updated_at < p_to AND s.status = 'completed'), 'unit', '项')
    ) INTO v_summary;

    WITH points AS (
      SELECT admin.analytics_bucket(u.created_at, p_grain) AS bucket, '新增用户'::TEXT AS metric, count(*)::NUMERIC AS value
      FROM miniapp.users u WHERE u.created_at >= p_from AND u.created_at < p_to GROUP BY 1
      UNION ALL
      SELECT admin.analytics_bucket(h.created_at, p_grain), '成功对话', count(*)::NUMERIC
      FROM miniapp.chat_history h WHERE h.created_at >= p_from AND h.created_at < p_to AND h.status = 'success' GROUP BY 1
      UNION ALL
      SELECT admin.analytics_bucket(o.paid_at, p_grain), '收入(元)', sum(o.amount_cents)::NUMERIC / 100
      FROM miniapp.payment_orders o WHERE o.paid_at >= p_from AND o.paid_at < p_to AND o.status = 'completed' GROUP BY 1
      UNION ALL
      SELECT admin.analytics_bucket(d.claimed_at, p_grain), '签到', count(*)::NUMERIC
      FROM miniapp.daily_checkins d WHERE d.claimed_at >= p_from AND d.claimed_at < p_to GROUP BY 1
    )
    SELECT jsonb_build_array(jsonb_build_object(
      'title', '核心指标趋势', 'type', 'line',
      'data', COALESCE(jsonb_agg(to_jsonb(points) ORDER BY bucket, metric), '[]'::JSONB)
    )) INTO v_charts FROM points;

    WITH rows AS (
      SELECT h.status AS "状态", count(*) AS "数量",
             round(count(*) * 100.0 / NULLIF(sum(count(*)) OVER (), 0), 2) AS "占比%"
      FROM miniapp.chat_history h
      WHERE h.created_at >= p_from AND h.created_at < p_to
      GROUP BY h.status ORDER BY count(*) DESC
    )
    SELECT jsonb_build_array(jsonb_build_object('title', '对话健康概览', 'rows', COALESCE(jsonb_agg(to_jsonb(rows)), '[]'::JSONB)))
    INTO v_tables FROM rows;

  ELSIF p_section = 'users' THEN
    SELECT jsonb_build_array(
      jsonb_build_object('label', '注册用户', 'value', count(*), 'unit', '人'),
      jsonb_build_object('label', 'Bot进入', 'value', count(*) FILTER (WHERE u.bot_entered_at IS NOT NULL), 'unit', '人'),
      jsonb_build_object('label', 'MiniApp进入', 'value', count(*) FILTER (WHERE u.miniapp_entered_at IS NOT NULL), 'unit', '人'),
      jsonb_build_object('label', 'ST初始化', 'value', count(*) FILTER (WHERE u.st_initialized_at IS NOT NULL), 'unit', '人'),
      jsonb_build_object('label', '有来源标记', 'value', count(*) FILTER (WHERE u.source_id IS NOT NULL), 'unit', '人')
    ) INTO v_summary
    FROM miniapp.users u WHERE u.created_at >= p_from AND u.created_at < p_to;

    WITH points AS (
      SELECT admin.analytics_bucket(u.created_at, p_grain) AS bucket, '注册'::TEXT AS metric, count(*)::NUMERIC AS value
      FROM miniapp.users u WHERE u.created_at >= p_from AND u.created_at < p_to GROUP BY 1
      UNION ALL
      SELECT admin.analytics_bucket(u.miniapp_entered_at, p_grain), '进入MiniApp', count(*)::NUMERIC
      FROM miniapp.users u WHERE u.miniapp_entered_at >= p_from AND u.miniapp_entered_at < p_to GROUP BY 1
      UNION ALL
      SELECT admin.analytics_bucket(u.st_initialized_at, p_grain), 'ST初始化', count(*)::NUMERIC
      FROM miniapp.users u WHERE u.st_initialized_at >= p_from AND u.st_initialized_at < p_to GROUP BY 1
    )
    SELECT jsonb_build_array(jsonb_build_object('title', '用户转化趋势', 'type', 'line',
      'data', COALESCE(jsonb_agg(to_jsonb(points) ORDER BY bucket, metric), '[]'::JSONB)))
    INTO v_charts FROM points;

    WITH rows AS (
      SELECT COALESCE(u.source_id, '无来源') AS "来源", count(*) AS "用户数",
        count(*) FILTER (WHERE u.st_initialized_at IS NOT NULL) AS "已初始化",
        round(avg(EXTRACT(epoch FROM (u.st_initialized_at - u.created_at)) / 60)
          FILTER (WHERE u.st_initialized_at IS NOT NULL), 2) AS "平均初始化分钟"
      FROM miniapp.users u WHERE u.created_at >= p_from AND u.created_at < p_to
      GROUP BY COALESCE(u.source_id, '无来源') ORDER BY count(*) DESC LIMIT 100
    )
    SELECT jsonb_build_array(jsonb_build_object('title', '来源与初始化质量', 'rows', COALESCE(jsonb_agg(to_jsonb(rows)), '[]'::JSONB)))
    INTO v_tables FROM rows;

  ELSIF p_section = 'retention' THEN
    SELECT jsonb_build_array(
      jsonb_build_object('label', 'DAU', 'value', (SELECT count(DISTINCT h.user_id) FROM miniapp.chat_history h WHERE h.created_at >= greatest(p_from, p_to - interval '1 day') AND h.created_at < p_to), 'unit', '人'),
      jsonb_build_object('label', 'WAU', 'value', (SELECT count(DISTINCT h.user_id) FROM miniapp.chat_history h WHERE h.created_at >= greatest(p_from, p_to - interval '7 days') AND h.created_at < p_to), 'unit', '人'),
      jsonb_build_object('label', 'MAU', 'value', (SELECT count(DISTINCT h.user_id) FROM miniapp.chat_history h WHERE h.created_at >= greatest(p_from, p_to - interval '30 days') AND h.created_at < p_to), 'unit', '人'),
      jsonb_build_object('label', '首聊用户', 'value', (SELECT count(DISTINCT h.user_id) FROM miniapp.chat_history h WHERE h.created_at >= p_from AND h.created_at < p_to), 'unit', '人')
    ) INTO v_summary;

    WITH points AS (
      SELECT date_trunc('day', h.created_at) AS bucket, 'DAU'::TEXT AS metric,
             count(DISTINCT h.user_id)::NUMERIC AS value
      FROM miniapp.chat_history h WHERE h.created_at >= p_from AND h.created_at < p_to GROUP BY 1
    )
    SELECT jsonb_build_array(jsonb_build_object('title', '每日活跃用户', 'type', 'line',
      'data', COALESCE(jsonb_agg(to_jsonb(points) ORDER BY bucket), '[]'::JSONB)))
    INTO v_charts FROM points;

    WITH cohorts AS (
      SELECT u.id AS user_id, date_trunc('week', u.created_at) AS cohort_week
      FROM miniapp.users u WHERE u.created_at >= p_from AND u.created_at < p_to
    ), activity AS (
      SELECT DISTINCT h.user_id, date_trunc('week', h.created_at) AS active_week
      FROM miniapp.chat_history h WHERE h.created_at >= p_from AND h.created_at < p_to
    ), rows AS (
      SELECT c.cohort_week::DATE AS "注册周",
             floor(EXTRACT(epoch FROM (a.active_week - c.cohort_week)) / 604800)::INTEGER AS "第N周",
             count(DISTINCT c.user_id) AS "留存用户"
      FROM cohorts c JOIN activity a ON a.user_id = c.user_id AND a.active_week >= c.cohort_week
      GROUP BY 1, 2 ORDER BY 1, 2
    )
    SELECT jsonb_build_array(jsonb_build_object('title', '注册 Cohort 留存', 'rows', COALESCE(jsonb_agg(to_jsonb(rows)), '[]'::JSONB)))
    INTO v_tables FROM rows;

  ELSIF p_section = 'chats' THEN
    SELECT jsonb_build_array(
      jsonb_build_object('label', '请求总数', 'value', count(*), 'unit', '轮'),
      jsonb_build_object('label', '成功请求', 'value', count(*) FILTER (WHERE h.status = 'success'), 'unit', '轮'),
      jsonb_build_object('label', '成功率', 'value', round(count(*) FILTER (WHERE h.status = 'success') * 100.0 / NULLIF(count(*), 0), 2), 'unit', '%'),
      jsonb_build_object('label', '对话用户', 'value', count(DISTINCT h.user_id), 'unit', '人'),
      jsonb_build_object('label', '涉及角色', 'value', count(DISTINCT h.character_id), 'unit', '个')
    ) INTO v_summary FROM miniapp.chat_history h WHERE h.created_at >= p_from AND h.created_at < p_to;

    WITH points AS (
      SELECT admin.analytics_bucket(h.created_at, p_grain) AS bucket, h.status AS metric, count(*)::NUMERIC AS value
      FROM miniapp.chat_history h WHERE h.created_at >= p_from AND h.created_at < p_to GROUP BY 1, 2
    )
    SELECT jsonb_build_array(jsonb_build_object('title', '对话状态趋势', 'type', 'column',
      'data', COALESCE(jsonb_agg(to_jsonb(points) ORDER BY bucket, metric), '[]'::JSONB)))
    INTO v_charts FROM points;

    WITH rows AS (
      SELECT h.status AS "状态", COALESCE(h.upstream_status::TEXT, '-') AS "上游状态码",
             count(*) AS "数量", count(DISTINCT h.user_id) AS "用户数"
      FROM miniapp.chat_history h WHERE h.created_at >= p_from AND h.created_at < p_to
      GROUP BY h.status, h.upstream_status ORDER BY count(*) DESC
    )
    SELECT jsonb_build_array(jsonb_build_object('title', '错误与状态码分布', 'rows', COALESCE(jsonb_agg(to_jsonb(rows)), '[]'::JSONB)))
    INTO v_tables FROM rows;

  ELSIF p_section = 'models' THEN
    WITH base AS (
      SELECT h.*,
        CASE WHEN COALESCE(h.llm_usage ->> 'cost', '') ~ '^[0-9]+([.][0-9]+)?$'
          THEN (h.llm_usage ->> 'cost')::NUMERIC ELSE 0 END AS cost_usd
      FROM miniapp.chat_history h WHERE h.created_at >= p_from AND h.created_at < p_to
    )
    SELECT jsonb_build_array(
      jsonb_build_object('label', '模型数', 'value', count(DISTINCT COALESCE(b.llm_model, b.model)), 'unit', '个'),
      jsonb_build_object('label', '请求数', 'value', count(*), 'unit', '次'),
      jsonb_build_object('label', 'Prompt Token', 'value', COALESCE(sum(b.llm_native_tokens_prompt), 0), 'unit', 'token'),
      jsonb_build_object('label', 'Completion Token', 'value', COALESCE(sum(b.llm_native_tokens_completion), 0), 'unit', 'token'),
      jsonb_build_object('label', 'OpenRouter成本', 'value', round(COALESCE(sum(b.cost_usd), 0), 6), 'unit', 'USD'),
      jsonb_build_object('label', '实际扣费', 'value', COALESCE(sum(b.deduction_rate), 0), 'unit', '星尘')
    ) INTO v_summary FROM base b;

    WITH points AS (
      SELECT admin.analytics_bucket(h.created_at, p_grain) AS bucket,
             COALESCE(h.llm_model, h.model) AS metric, count(*)::NUMERIC AS value
      FROM miniapp.chat_history h WHERE h.created_at >= p_from AND h.created_at < p_to
      GROUP BY 1, 2
    )
    SELECT jsonb_build_array(jsonb_build_object('title', '模型请求趋势', 'type', 'line',
      'data', COALESCE(jsonb_agg(to_jsonb(points) ORDER BY bucket, metric), '[]'::JSONB)))
    INTO v_charts FROM points;

    WITH rows AS (
      SELECT COALESCE(h.llm_model, h.model) AS "模型", COALESCE(h.llm_provider_name, '-') AS "供应商",
        count(*) AS "请求数", count(DISTINCT h.user_id) AS "用户数",
        round(count(*) FILTER (WHERE h.status = 'success') * 100.0 / NULLIF(count(*), 0), 2) AS "成功率%",
        COALESCE(sum(h.llm_native_tokens_prompt), 0) AS "输入Token",
        COALESCE(sum(h.llm_native_tokens_completion), 0) AS "输出Token",
        COALESCE(sum(h.llm_native_tokens_cached), 0) AS "缓存Token",
        COALESCE(sum(h.llm_native_tokens_reasoning), 0) AS "推理Token",
        round(avg(h.llm_latency), 2) AS "平均首Token毫秒",
        round(avg(h.llm_generation_time), 2) AS "平均生成毫秒",
        COALESCE(sum(h.deduction_rate), 0) AS "实际扣费"
      FROM miniapp.chat_history h WHERE h.created_at >= p_from AND h.created_at < p_to
      GROUP BY 1, 2 ORDER BY count(*) DESC
    )
    SELECT jsonb_build_array(jsonb_build_object('title', '模型成本与质量明细', 'rows', COALESCE(jsonb_agg(to_jsonb(rows)), '[]'::JSONB)))
    INTO v_tables FROM rows;

  ELSIF p_section = 'characters' THEN
    SELECT jsonb_build_array(
      jsonb_build_object('label', '上架角色', 'value', count(*) FILTER (WHERE c.enabled AND c.archived_at IS NULL), 'unit', '个'),
      jsonb_build_object('label', '下架角色', 'value', count(*) FILTER (WHERE NOT c.enabled AND c.archived_at IS NULL), 'unit', '个'),
      jsonb_build_object('label', '已归档', 'value', count(*) FILTER (WHERE c.archived_at IS NOT NULL), 'unit', '个'),
      jsonb_build_object('label', '期间被使用', 'value', (SELECT count(DISTINCT h.character_id) FROM miniapp.chat_history h WHERE h.created_at >= p_from AND h.created_at < p_to), 'unit', '个')
    ) INTO v_summary FROM miniapp.characters c;

    WITH points AS (
      SELECT admin.analytics_bucket(h.created_at, p_grain) AS bucket, COALESCE(c.name, '未知角色') AS metric,
             count(*)::NUMERIC AS value
      FROM miniapp.chat_history h LEFT JOIN miniapp.characters c ON c.id = h.character_id
      WHERE h.created_at >= p_from AND h.created_at < p_to
      GROUP BY 1, 2
    )
    SELECT jsonb_build_array(jsonb_build_object('title', '角色对话趋势', 'type', 'line',
      'data', COALESCE(jsonb_agg(to_jsonb(points) ORDER BY bucket, metric), '[]'::JSONB)))
    INTO v_charts FROM points;

    WITH rows AS (
      SELECT c.name AS "角色", c.creator AS "创作者", c.enabled AS "上架", c.sort_order AS "排序",
        count(h.id) AS "对话轮数", count(DISTINCT h.user_id) AS "用户数",
        round(count(h.id)::NUMERIC / NULLIF(count(DISTINCT h.user_id), 0), 2) AS "人均轮数",
        round(count(h.id) FILTER (WHERE h.status = 'success') * 100.0 / NULLIF(count(h.id), 0), 2) AS "成功率%"
      FROM miniapp.characters c
      LEFT JOIN miniapp.chat_history h ON h.character_id = c.id AND h.created_at >= p_from AND h.created_at < p_to
      GROUP BY c.id, c.name, c.creator, c.enabled, c.sort_order
      ORDER BY count(h.id) DESC, c.sort_order LIMIT 300
    )
    SELECT jsonb_build_array(jsonb_build_object('title', '角色表现排行榜', 'rows', COALESCE(jsonb_agg(to_jsonb(rows)), '[]'::JSONB)))
    INTO v_tables FROM rows;

  ELSIF p_section = 'billing' THEN
    SELECT jsonb_build_array(
      jsonb_build_object('label', '订单数', 'value', count(*), 'unit', '笔'),
      jsonb_build_object('label', '完成订单', 'value', count(*) FILTER (WHERE o.status = 'completed'), 'unit', '笔'),
      jsonb_build_object('label', 'GMV', 'value', COALESCE(sum(o.amount_cents) FILTER (WHERE o.status = 'completed'), 0), 'unit', '分'),
      jsonb_build_object('label', '付费人数', 'value', count(DISTINCT o.user_id) FILTER (WHERE o.status = 'completed'), 'unit', '人'),
      jsonb_build_object('label', '售出星尘', 'value', COALESCE(sum(o.credits_amount + o.bonus_credits) FILTER (WHERE o.status = 'completed'), 0), 'unit', '星尘'),
      jsonb_build_object('label', '平均支付秒数', 'value', round(avg(EXTRACT(epoch FROM (o.paid_at - o.created_at))) FILTER (WHERE o.paid_at IS NOT NULL), 2), 'unit', '秒')
    ) INTO v_summary FROM miniapp.payment_orders o WHERE o.created_at >= p_from AND o.created_at < p_to;

    WITH points AS (
      SELECT admin.analytics_bucket(o.created_at, p_grain) AS bucket, o.status AS metric, count(*)::NUMERIC AS value
      FROM miniapp.payment_orders o WHERE o.created_at >= p_from AND o.created_at < p_to GROUP BY 1, 2
      UNION ALL
      SELECT admin.analytics_bucket(o.paid_at, p_grain), '收入(元)', sum(o.amount_cents)::NUMERIC / 100
      FROM miniapp.payment_orders o WHERE o.paid_at >= p_from AND o.paid_at < p_to AND o.status = 'completed' GROUP BY 1
    )
    SELECT jsonb_build_array(jsonb_build_object('title', '订单与收入趋势', 'type', 'column',
      'data', COALESCE(jsonb_agg(to_jsonb(points) ORDER BY bucket, metric), '[]'::JSONB)))
    INTO v_charts FROM points;

    WITH order_rows AS (
      SELECT o.status AS "状态", COALESCE(o.payment_type, '-') AS "支付方式", count(*) AS "订单数",
        COALESCE(sum(o.amount_cents), 0) AS "金额(分)",
        COALESCE(sum(o.credits_amount), 0) AS "基础星尘",
        COALESCE(sum(o.bonus_credits), 0) AS "赠送星尘"
      FROM miniapp.payment_orders o WHERE o.created_at >= p_from AND o.created_at < p_to
      GROUP BY o.status, o.payment_type ORDER BY count(*) DESC
    ), ledger_rows AS (
      SELECT l.entry_type AS "流水类型", count(*) AS "笔数", sum(l.amount) AS "变动星尘",
             sum(l.main_delta) AS "主余额变动", sum(l.bonus_delta) AS "赠送余额变动"
      FROM miniapp.wallet_ledger l WHERE l.created_at >= p_from AND l.created_at < p_to
      GROUP BY l.entry_type ORDER BY count(*) DESC
    )
    SELECT jsonb_build_array(
      jsonb_build_object('title', '订单漏斗与支付方式', 'rows', COALESCE((SELECT jsonb_agg(to_jsonb(order_rows)) FROM order_rows), '[]'::JSONB)),
      jsonb_build_object('title', '星尘流水构成', 'rows', COALESCE((SELECT jsonb_agg(to_jsonb(ledger_rows)) FROM ledger_rows), '[]'::JSONB))
    ) INTO v_tables;

  ELSIF p_section = 'checkins' THEN
    SELECT jsonb_build_array(
      jsonb_build_object('label', '签到次数', 'value', count(*), 'unit', '次'),
      jsonb_build_object('label', '签到人数', 'value', count(DISTINCT d.user_id), 'unit', '人'),
      jsonb_build_object('label', '发放奖励', 'value', COALESCE(sum(d.reward_credits), 0), 'unit', '星尘'),
      jsonb_build_object('label', '人均签到', 'value', round(count(*)::NUMERIC / NULLIF(count(DISTINCT d.user_id), 0), 2), 'unit', '次')
    ) INTO v_summary FROM miniapp.daily_checkins d WHERE d.claimed_at >= p_from AND d.claimed_at < p_to;

    WITH points AS (
      SELECT admin.analytics_bucket(d.claimed_at, p_grain) AS bucket, '签到次数'::TEXT AS metric, count(*)::NUMERIC AS value
      FROM miniapp.daily_checkins d WHERE d.claimed_at >= p_from AND d.claimed_at < p_to GROUP BY 1
      UNION ALL
      SELECT admin.analytics_bucket(d.claimed_at, p_grain), '签到人数', count(DISTINCT d.user_id)::NUMERIC
      FROM miniapp.daily_checkins d WHERE d.claimed_at >= p_from AND d.claimed_at < p_to GROUP BY 1
    )
    SELECT jsonb_build_array(jsonb_build_object('title', '签到趋势', 'type', 'line',
      'data', COALESCE(jsonb_agg(to_jsonb(points) ORDER BY bucket, metric), '[]'::JSONB)))
    INTO v_charts FROM points;

    WITH rows AS (
      SELECT d.reward_credits AS "单次奖励", count(*) AS "签到次数",
        count(DISTINCT d.user_id) AS "用户数", sum(d.reward_credits) AS "总奖励"
      FROM miniapp.daily_checkins d WHERE d.claimed_at >= p_from AND d.claimed_at < p_to
      GROUP BY d.reward_credits ORDER BY d.reward_credits
    )
    SELECT jsonb_build_array(jsonb_build_object('title', '签到奖励分布', 'rows', COALESCE(jsonb_agg(to_jsonb(rows)), '[]'::JSONB)))
    INTO v_tables FROM rows;

  ELSIF p_section = 'growth' THEN
    IF to_regclass('growth.channel_links') IS NULL THEN
      v_notes := jsonb_build_array('当前环境未部署 growth schema，无法生成渠道点击报表。用户 source_id 仍会单独统计。');
      v_rows := '[]'::JSONB;
    ELSE
      EXECUTE $dynamic$
        SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY "用户数" DESC), '[]'::JSONB)
        FROM (
          SELECT l.source_name AS "渠道", l.source_id AS "来源ID", l.status AS "状态",
            count(DISTINCT u.id) FILTER (WHERE u.created_at >= $1 AND u.created_at < $2) AS "用户数",
            count(DISTINCT u.id) FILTER (
              WHERE u.created_at >= $1 AND u.created_at < $2 AND u.st_initialized_at IS NOT NULL
            ) AS "激活用户",
            (SELECT count(*) FROM growth.link_clicks c
              WHERE c.source_id = l.source_id AND c.clicked_at >= $1 AND c.clicked_at < $2) AS "点击数",
            (SELECT count(*) FROM growth.miniapp_entries e
              WHERE e.source_id = l.source_id AND e.entered_at >= $1 AND e.entered_at < $2) AS "进入数"
          FROM growth.channel_links l
          LEFT JOIN miniapp.users u ON u.source_id = l.source_id
          GROUP BY l.id, l.source_name, l.source_id, l.status
        ) row_data
      $dynamic$ INTO v_rows USING p_from, p_to;
      IF jsonb_array_length(v_rows) = 0 THEN
        v_notes := jsonb_build_array('growth schema 已部署，但当前没有渠道链接数据。');
      END IF;
    END IF;

    SELECT jsonb_build_array(
      jsonb_build_object('label', '有来源用户', 'value', count(*) FILTER (WHERE u.source_id IS NOT NULL), 'unit', '人'),
      jsonb_build_object('label', '来源数', 'value', count(DISTINCT u.source_id) FILTER (WHERE u.source_id IS NOT NULL), 'unit', '个'),
      jsonb_build_object('label', '来源激活用户', 'value', count(*) FILTER (WHERE u.source_id IS NOT NULL AND u.st_initialized_at IS NOT NULL), 'unit', '人')
    ) INTO v_summary FROM miniapp.users u WHERE u.created_at >= p_from AND u.created_at < p_to;
    v_tables := jsonb_build_array(jsonb_build_object('title', '渠道归因明细', 'rows', v_rows));

  ELSIF p_section = 'outreach' THEN
    SELECT jsonb_build_array(
      jsonb_build_object('label', '回访会话', 'value', count(*), 'unit', '个'),
      jsonb_build_object('label', '等待回复', 'value', count(*) FILTER (WHERE s.status = 'waiting_reply'), 'unit', '个'),
      jsonb_build_object('label', '发送失败', 'value', count(*) FILTER (WHERE s.status = 'send_failed'), 'unit', '个'),
      jsonb_build_object('label', '已回复用户', 'value', (SELECT count(DISTINCT m.user_id) FROM cs_platform.outreach_messages m WHERE m.received_at >= p_from AND m.received_at < p_to AND m.direction = 'user'), 'unit', '人')
    ) INTO v_summary FROM cs_platform.outreach_sessions s WHERE s.created_at >= p_from AND s.created_at < p_to;

    WITH points AS (
      SELECT admin.analytics_bucket(m.created_at, p_grain) AS bucket,
             concat(m.direction, ':', m.send_status) AS metric, count(*)::NUMERIC AS value
      FROM cs_platform.outreach_messages m WHERE m.created_at >= p_from AND m.created_at < p_to
      GROUP BY 1, 2
    )
    SELECT jsonb_build_array(jsonb_build_object('title', '回访消息趋势', 'type', 'column',
      'data', COALESCE(jsonb_agg(to_jsonb(points) ORDER BY bucket, metric), '[]'::JSONB)))
    INTO v_charts FROM points;

    WITH session_rows AS (
      SELECT s.status AS "会话状态", COALESCE(s.current_stage, '-') AS "SOP阶段", count(*) AS "数量"
      FROM cs_platform.outreach_sessions s WHERE s.created_at >= p_from AND s.created_at < p_to
      GROUP BY s.status, s.current_stage ORDER BY count(*) DESC
    ), failure_rows AS (
      SELECT COALESCE(m.failed_reason, '未记录原因') AS "失败原因", count(*) AS "数量"
      FROM cs_platform.outreach_messages m
      WHERE m.created_at >= p_from AND m.created_at < p_to AND m.send_status = 'failed'
      GROUP BY m.failed_reason ORDER BY count(*) DESC LIMIT 50
    )
    SELECT jsonb_build_array(
      jsonb_build_object('title', '回访会话与 SOP 阶段', 'rows', COALESCE((SELECT jsonb_agg(to_jsonb(session_rows)) FROM session_rows), '[]'::JSONB)),
      jsonb_build_object('title', '发送失败原因', 'rows', COALESCE((SELECT jsonb_agg(to_jsonb(failure_rows)) FROM failure_rows), '[]'::JSONB))
    ) INTO v_tables;

  ELSIF p_section = 'system' THEN
    SELECT jsonb_build_array(
      jsonb_build_object('label', '同步任务', 'value', count(*), 'unit', '项'),
      jsonb_build_object('label', '同步完成', 'value', count(*) FILTER (WHERE s.status = 'completed'), 'unit', '项'),
      jsonb_build_object('label', '同步失败', 'value', count(*) FILTER (WHERE s.status IN ('failed', 'dead')), 'unit', '项'),
      jsonb_build_object('label', '发生重试', 'value', count(*) FILTER (WHERE s.attempts > 1), 'unit', '项'),
      jsonb_build_object('label', 'LLM元数据完整率', 'value', (
        SELECT round(count(*) FILTER (WHERE h.llm_usage IS NOT NULL) * 100.0 / NULLIF(count(*), 0), 2)
        FROM miniapp.chat_history h WHERE h.created_at >= p_from AND h.created_at < p_to
      ), 'unit', '%')
    ) INTO v_summary FROM st_infra.sync_tasks s WHERE s.created_at >= p_from AND s.created_at < p_to;

    WITH points AS (
      SELECT admin.analytics_bucket(s.created_at, p_grain) AS bucket, s.status AS metric, count(*)::NUMERIC AS value
      FROM st_infra.sync_tasks s WHERE s.created_at >= p_from AND s.created_at < p_to GROUP BY 1, 2
    )
    SELECT jsonb_build_array(jsonb_build_object('title', '同步任务趋势', 'type', 'line',
      'data', COALESCE(jsonb_agg(to_jsonb(points) ORDER BY bucket, metric), '[]'::JSONB)))
    INTO v_charts FROM points;

    WITH sync_rows AS (
      SELECT s.task_type AS "任务类型", s.status AS "状态", count(*) AS "数量",
             max(s.attempts) AS "最大尝试次数",
             count(*) FILTER (WHERE s.next_retry_at IS NOT NULL AND s.next_retry_at <= now()) AS "到期重试"
      FROM st_infra.sync_tasks s WHERE s.created_at >= p_from AND s.created_at < p_to
      GROUP BY s.task_type, s.status ORDER BY count(*) DESC
    ), audit_rows AS (
      SELECT a.action AS "运营动作", COALESCE(a.actor_name, a.actor_email) AS "操作人", count(*) AS "次数"
      FROM admin.audit_logs a
      WHERE a.environment = admin.current_environment() AND a.created_at >= p_from AND a.created_at < p_to
      GROUP BY a.action, COALESCE(a.actor_name, a.actor_email) ORDER BY count(*) DESC
    )
    SELECT jsonb_build_array(
      jsonb_build_object('title', '同步任务状态', 'rows', COALESCE((SELECT jsonb_agg(to_jsonb(sync_rows)) FROM sync_rows), '[]'::JSONB)),
      jsonb_build_object('title', '运营操作统计', 'rows', COALESCE((SELECT jsonb_agg(to_jsonb(audit_rows)) FROM audit_rows), '[]'::JSONB))
    ) INTO v_tables;
  END IF;

  RETURN jsonb_build_object(
    'section', p_section,
    'from', p_from,
    'to', p_to,
    'grain', p_grain,
    'summary', COALESCE(v_summary, '[]'::JSONB),
    'charts', COALESCE(v_charts, '[]'::JSONB),
    'tables', COALESCE(v_tables, '[]'::JSONB),
    'notes', COALESCE(v_notes, '[]'::JSONB),
    'generated_at', now()
  );
END;
$$;

CREATE OR REPLACE FUNCTION admin.list_analytics_users(
  p_search TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
) RETURNS TABLE (
  user_id UUID,
  tg_id TEXT,
  tg_username TEXT,
  display_name TEXT,
  source_id TEXT,
  created_at TIMESTAMPTZ,
  miniapp_entered_at TIMESTAMPTZ,
  st_initialized_at TIMESTAMPTZ,
  total_round BIGINT,
  total_credits INTEGER,
  total_paid_amount NUMERIC,
  last_active_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM admin.analytics_require_access(true);
  IF p_limit NOT BETWEEN 1 AND 100 OR p_offset NOT BETWEEN 0 AND 10000 THEN
    RAISE EXCEPTION 'analytics pagination is outside the allowed range'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT u.id, u.tg_id, s.tg_username, COALESCE(s.display_name, s.tg_first_name),
    u.source_id, u.created_at, u.miniapp_entered_at, u.st_initialized_at,
    COALESCE(s.total_round, u.total_round), COALESCE(w.total_credits, 0),
    COALESCE(w.total_paid_amount, 0),
    (SELECT max(h.created_at) FROM miniapp.chat_history h WHERE h.user_id = u.id)
  FROM miniapp.users u
  LEFT JOIN miniapp.miniapp_user_settings s ON s.user_id = u.id
  LEFT JOIN miniapp.user_wallets w ON w.user_id = u.id
  WHERE p_search IS NULL OR trim(p_search) = ''
     OR u.id::TEXT ILIKE '%' || trim(p_search) || '%'
     OR u.tg_id ILIKE '%' || trim(p_search) || '%'
     OR COALESCE(s.tg_username, '') ILIKE '%' || trim(p_search) || '%'
     OR COALESCE(s.display_name, '') ILIKE '%' || trim(p_search) || '%'
  ORDER BY u.created_at DESC, u.id
  LIMIT p_limit OFFSET p_offset;
END;
$$;

CREATE OR REPLACE FUNCTION admin.list_analytics_chats(
  p_from TIMESTAMPTZ DEFAULT (now() - interval '30 days'),
  p_to TIMESTAMPTZ DEFAULT now(),
  p_search TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
) RETURNS TABLE (
  id UUID,
  user_id UUID,
  tg_id TEXT,
  display_name TEXT,
  character_name TEXT,
  model TEXT,
  provider TEXT,
  status TEXT,
  upstream_status INTEGER,
  deduction_rate NUMERIC,
  llm_latency NUMERIC,
  llm_generation_time NUMERIC,
  user_input_preview TEXT,
  assistant_reply_preview TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM admin.analytics_require_access(true);
  IF p_limit NOT BETWEEN 1 AND 100 OR p_offset NOT BETWEEN 0 AND 10000
     OR p_from >= p_to OR p_to - p_from > interval '366 days' THEN
    RAISE EXCEPTION 'analytics detail query is outside the allowed range'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT h.id, h.user_id, u.tg_id, COALESCE(s.display_name, s.tg_username),
    c.name, COALESCE(h.llm_model, h.model), h.llm_provider_name, h.status,
    h.upstream_status, h.deduction_rate, h.llm_latency, h.llm_generation_time,
    left(h.user_input, 160), left(COALESCE(h.assistant_reply, ''), 160), h.created_at
  FROM miniapp.chat_history h
  JOIN miniapp.users u ON u.id = h.user_id
  LEFT JOIN miniapp.miniapp_user_settings s ON s.user_id = h.user_id
  LEFT JOIN miniapp.characters c ON c.id = h.character_id
  WHERE h.created_at >= p_from AND h.created_at < p_to
    AND (p_status IS NULL OR p_status = '' OR h.status = p_status)
    AND (
      p_search IS NULL OR trim(p_search) = ''
      OR u.tg_id ILIKE '%' || trim(p_search) || '%'
      OR COALESCE(s.display_name, '') ILIKE '%' || trim(p_search) || '%'
      OR h.model ILIKE '%' || trim(p_search) || '%'
      OR COALESCE(c.name, '') ILIKE '%' || trim(p_search) || '%'
    )
  ORDER BY h.created_at DESC, h.id
  LIMIT p_limit OFFSET p_offset;
END;
$$;

CREATE OR REPLACE FUNCTION admin.get_analytics_chat_detail(p_chat_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_result JSONB;
BEGIN
  PERFORM admin.analytics_require_access(true);
  SELECT to_jsonb(h) || jsonb_build_object(
    'tg_id', u.tg_id,
    'tg_username', s.tg_username,
    'display_name', COALESCE(s.display_name, s.tg_first_name),
    'character_name', c.name
  ) INTO v_result
  FROM miniapp.chat_history h
  JOIN miniapp.users u ON u.id = h.user_id
  LEFT JOIN miniapp.miniapp_user_settings s ON s.user_id = h.user_id
  LEFT JOIN miniapp.characters c ON c.id = h.character_id
  WHERE h.id = p_chat_id;
  IF v_result IS NULL THEN
    RAISE EXCEPTION 'chat history row not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION admin.list_analytics_outreach_messages(
  p_from TIMESTAMPTZ DEFAULT (now() - interval '30 days'),
  p_to TIMESTAMPTZ DEFAULT now(),
  p_search TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
) RETURNS TABLE (
  id UUID,
  persona_name TEXT,
  user_id UUID,
  telegram_user_id TEXT,
  direction TEXT,
  sop_stage TEXT,
  question_key TEXT,
  content TEXT,
  send_status TEXT,
  failed_reason TEXT,
  operator_id TEXT,
  sent_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM admin.analytics_require_access(true);
  IF p_limit NOT BETWEEN 1 AND 100 OR p_offset NOT BETWEEN 0 AND 10000
     OR p_from >= p_to OR p_to - p_from > interval '366 days' THEN
    RAISE EXCEPTION 'analytics detail query is outside the allowed range'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT m.id, p.name, m.user_id, m.telegram_user_id, m.direction, m.sop_stage,
    m.question_key, m.content, m.send_status, m.failed_reason, m.operator_id,
    m.sent_at, m.received_at, m.created_at
  FROM cs_platform.outreach_messages m
  LEFT JOIN cs_platform.personas p ON p.id = m.persona_id
  WHERE m.created_at >= p_from AND m.created_at < p_to
    AND (p_status IS NULL OR p_status = '' OR m.send_status = p_status)
    AND (
      p_search IS NULL OR trim(p_search) = ''
      OR m.telegram_user_id ILIKE '%' || trim(p_search) || '%'
      OR m.content ILIKE '%' || trim(p_search) || '%'
      OR COALESCE(p.name, '') ILIKE '%' || trim(p_search) || '%'
    )
  ORDER BY m.created_at DESC, m.id
  LIMIT p_limit OFFSET p_offset;
END;
$$;

CREATE OR REPLACE FUNCTION admin.get_analytics_user_detail(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_result JSONB;
BEGIN
  PERFORM admin.analytics_require_access(true);
  SELECT jsonb_build_object(
    'user', to_jsonb(u),
    'settings', to_jsonb(s),
    'wallet', to_jsonb(w),
    'payments', COALESCE((
      SELECT jsonb_agg(to_jsonb(o) ORDER BY o.created_at DESC)
      FROM miniapp.payment_orders o WHERE o.user_id = u.id
    ), '[]'::JSONB),
    'ledger', COALESCE((
      SELECT jsonb_agg(to_jsonb(l) ORDER BY l.created_at DESC)
      FROM (SELECT * FROM miniapp.wallet_ledger wl WHERE wl.user_id = u.id ORDER BY wl.created_at DESC LIMIT 100) l
    ), '[]'::JSONB),
    'checkins', COALESCE((
      SELECT jsonb_agg(to_jsonb(d) ORDER BY d.claimed_at DESC)
      FROM (SELECT * FROM miniapp.daily_checkins dc WHERE dc.user_id = u.id ORDER BY dc.claimed_at DESC LIMIT 100) d
    ), '[]'::JSONB),
    'recent_chats', COALESCE((
      SELECT jsonb_agg(to_jsonb(h) ORDER BY h.created_at DESC)
      FROM (
        SELECT ch.id, ch.model, ch.character_id, ch.status, ch.deduction_rate,
          ch.user_input, ch.assistant_reply, ch.created_at
        FROM miniapp.chat_history ch WHERE ch.user_id = u.id
        ORDER BY ch.created_at DESC LIMIT 50
      ) h
    ), '[]'::JSONB),
    'outreach_messages', COALESCE((
      SELECT jsonb_agg(to_jsonb(m) ORDER BY m.created_at DESC)
      FROM (
        SELECT om.* FROM cs_platform.outreach_messages om WHERE om.user_id = u.id
        ORDER BY om.created_at DESC LIMIT 100
      ) m
    ), '[]'::JSONB)
  ) INTO v_result
  FROM miniapp.users u
  LEFT JOIN miniapp.miniapp_user_settings s ON s.user_id = u.id
  LEFT JOIN miniapp.user_wallets w ON w.user_id = u.id
  WHERE u.id = p_user_id;
  IF v_result IS NULL THEN
    RAISE EXCEPTION 'analytics user not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION admin.analytics_require_access(BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.analytics_bucket(TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.get_analytics_dashboard(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.list_analytics_users(TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.list_analytics_chats(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.get_analytics_chat_detail(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.list_analytics_outreach_messages(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.get_analytics_user_detail(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION admin.get_analytics_dashboard(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.list_analytics_users(TEXT, INTEGER, INTEGER) TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.list_analytics_chats(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, INTEGER, INTEGER) TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.get_analytics_chat_detail(UUID) TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.list_analytics_outreach_messages(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, INTEGER, INTEGER) TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.get_analytics_user_detail(UUID) TO authenticated, service_role, postgres;

COMMIT;
