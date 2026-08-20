-- 087 归档：被 087_drop_dead_admin_rpcs.sql 删除的 21 个 admin RPC 的现行定义。
-- 来源：production（wbtsfzozlmurljvglhpn），导出于 2026-08-20，pg_get_functiondef 原样输出。
--
-- 为什么要单独留档而不是指回历史迁移：
--   · admin.list_character_favorite_leaderboard 不在任何迁移文件里，是直接在库里手建的；
--   · 其余函数的线上定义可能已相对 043 / 044 / 050 / 053 / 068 / 085 发生手工漂移。
-- 本文件不参与执行，仅供需要复原时取用。

-- ============================================================
-- admin.analytics_bucket(p_timestamp timestamp with time zone, p_grain text)
-- ============================================================
CREATE OR REPLACE FUNCTION admin.analytics_bucket(p_timestamp timestamp with time zone, p_grain text)
 RETURNS timestamp with time zone
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT CASE p_grain
    WHEN 'hour' THEN date_trunc('hour', p_timestamp)
    WHEN 'week' THEN date_trunc('week', p_timestamp)
    WHEN 'month' THEN date_trunc('month', p_timestamp)
    ELSE date_trunc('day', p_timestamp)
  END
$function$
;

-- ============================================================
-- admin.analytics_require_access(p_details boolean)
-- ============================================================
CREATE OR REPLACE FUNCTION admin.analytics_require_access(p_details boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
$function$
;

-- ============================================================
-- admin.create_platform_preset(p_display_name text, p_preset_payload jsonb, p_enabled boolean, p_sort_order integer)
-- ============================================================
CREATE OR REPLACE FUNCTION admin.create_platform_preset(p_display_name text, p_preset_payload jsonb, p_enabled boolean DEFAULT true, p_sort_order integer DEFAULT NULL::integer)
 RETURNS st_platform.platform_presets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_name TEXT;
  v_order INTEGER;
  v_created st_platform.platform_presets%ROWTYPE;
BEGIN
  SELECT admin_user.* INTO v_actor
  FROM admin.admin_users AS admin_user
  WHERE admin_user.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  v_name := trim(COALESCE(p_display_name, ''));
  IF char_length(v_name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'preset display name must contain 1 to 80 characters'
      USING ERRCODE = '22023';
  END IF;
  PERFORM admin.validate_platform_preset_payload(p_preset_payload);

  IF p_sort_order IS NOT NULL AND p_sort_order < 0 THEN
    RAISE EXCEPTION 'preset sort order must not be negative'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(p_sort_order, max(preset.sort_order) + 1, 0)
  INTO v_order
  FROM st_platform.platform_presets AS preset;

  INSERT INTO st_platform.platform_presets (
    display_name, preset_payload, is_default, sort_order, enabled
  ) VALUES (
    v_name, p_preset_payload, false, v_order, COALESCE(p_enabled, true)
  )
  RETURNING * INTO v_created;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    'platform_preset.create', 'st_platform', 'platform_presets', v_created.id::TEXT,
    NULL, to_jsonb(v_created) - 'preset_payload'
  );

  RETURN v_created;
END;
$function$
;

-- ============================================================
-- admin.get_analytics_chat_detail(p_chat_id uuid)
-- ============================================================
CREATE OR REPLACE FUNCTION admin.get_analytics_chat_detail(p_chat_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
$function$
;

-- ============================================================
-- admin.get_analytics_dashboard(p_section text, p_from timestamp with time zone, p_to timestamp with time zone, p_grain text)
-- ============================================================
CREATE OR REPLACE FUNCTION admin.get_analytics_dashboard(p_section text, p_from timestamp with time zone DEFAULT (now() - '30 days'::interval), p_to timestamp with time zone DEFAULT now(), p_grain text DEFAULT 'day'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
$function$
;

-- ============================================================
-- admin.get_analytics_user_detail(p_user_id uuid)
-- ============================================================
CREATE OR REPLACE FUNCTION admin.get_analytics_user_detail(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
$function$
;

-- ============================================================
-- admin.get_llm_usage_charge_detail(p_charge_id uuid)
-- ============================================================
CREATE OR REPLACE FUNCTION admin.get_llm_usage_charge_detail(p_charge_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_result JSONB;
BEGIN
  PERFORM admin.analytics_require_access(true);
  SELECT to_jsonb(charge) || jsonb_build_object(
    'tg_id', users.tg_id,
    'tg_username', settings.tg_username,
    'display_name', COALESCE(settings.display_name, settings.tg_first_name),
    'ledger_entries', COALESCE((
      SELECT jsonb_agg(to_jsonb(ledger) ORDER BY ledger.created_at)
      FROM miniapp.wallet_ledger AS ledger
      WHERE ledger.reference_type = 'llm_usage'
        AND ledger.reference_id = charge.charge_key::TEXT
    ), '[]'::JSONB)
  ) INTO v_result
  FROM miniapp.llm_usage_charges AS charge
  JOIN miniapp.users AS users ON users.id = charge.user_id
  LEFT JOIN miniapp.miniapp_user_settings AS settings ON settings.user_id = charge.user_id
  WHERE charge.id = p_charge_id;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'LLM usage charge not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_result;
END;
$function$
;

-- ============================================================
-- admin.list_analytics_chats(p_from timestamp with time zone, p_to timestamp with time zone, p_search text, p_status text, p_limit integer, p_offset integer)
-- ============================================================
CREATE OR REPLACE FUNCTION admin.list_analytics_chats(p_from timestamp with time zone DEFAULT (now() - '30 days'::interval), p_to timestamp with time zone DEFAULT now(), p_search text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, user_id uuid, tg_id text, display_name text, character_name text, model text, provider text, status text, upstream_status integer, deduction_rate numeric, llm_latency numeric, llm_generation_time numeric, user_input_preview text, assistant_reply_preview text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
$function$
;

-- ============================================================
-- admin.list_analytics_outreach_messages(p_from timestamp with time zone, p_to timestamp with time zone, p_search text, p_status text, p_limit integer, p_offset integer)
-- ============================================================
CREATE OR REPLACE FUNCTION admin.list_analytics_outreach_messages(p_from timestamp with time zone DEFAULT (now() - '30 days'::interval), p_to timestamp with time zone DEFAULT now(), p_search text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, persona_name text, user_id uuid, telegram_user_id text, direction text, sop_stage text, question_key text, content text, send_status text, failed_reason text, operator_id text, sent_at timestamp with time zone, received_at timestamp with time zone, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
$function$
;

-- ============================================================
-- admin.list_analytics_users(p_search text, p_limit integer, p_offset integer)
-- ============================================================
CREATE OR REPLACE FUNCTION admin.list_analytics_users(p_search text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(user_id uuid, tg_id text, tg_username text, display_name text, source_id text, created_at timestamp with time zone, miniapp_entered_at timestamp with time zone, st_initialized_at timestamp with time zone, total_round bigint, total_credits numeric, total_paid_amount numeric, last_active_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
$function$
;

-- ============================================================
-- admin.list_character_favorite_leaderboard(p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer)
-- ============================================================
CREATE OR REPLACE FUNCTION admin.list_character_favorite_leaderboard(p_from timestamp with time zone DEFAULT (now() - '30 days'::interval), p_to timestamp with time zone DEFAULT now(), p_limit integer DEFAULT 50)
 RETURNS TABLE(rank bigint, character_id uuid, character_name text, enabled boolean, favorite_count bigint, new_favorite_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  PERFORM admin.analytics_require_access(false);
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to
     OR p_to - p_from > interval '366 days' THEN
    RAISE EXCEPTION 'favorite leaderboard range is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'favorite leaderboard limit is invalid' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH favorite_counts AS (
    SELECT
      characters.id,
      characters.name,
      characters.enabled AND characters.archived_at IS NULL AS is_enabled,
      count(favorites.user_id) AS total_count,
      count(favorites.user_id) FILTER (
        WHERE favorites.created_at >= p_from AND favorites.created_at < p_to
      ) AS period_count
    FROM miniapp.characters AS characters
    LEFT JOIN miniapp.character_favorites AS favorites
      ON favorites.character_id = characters.id
    GROUP BY characters.id, characters.name, characters.enabled, characters.archived_at
  )
  SELECT
    row_number() OVER (ORDER BY total_count DESC, period_count DESC, name ASC),
    id,
    name,
    is_enabled,
    total_count,
    period_count
  FROM favorite_counts
  ORDER BY total_count DESC, period_count DESC, name ASC
  LIMIT p_limit;
END;
$function$
;

-- ============================================================
-- admin.list_llm_usage_charges(p_from timestamp with time zone, p_to timestamp with time zone, p_search text, p_model text, p_fallback boolean, p_status text, p_limit integer, p_offset integer)
-- ============================================================
CREATE OR REPLACE FUNCTION admin.list_llm_usage_charges(p_from timestamp with time zone DEFAULT (now() - '30 days'::interval), p_to timestamp with time zone DEFAULT now(), p_search text DEFAULT NULL::text, p_model text DEFAULT NULL::text, p_fallback boolean DEFAULT NULL::boolean, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, charge_key uuid, generation_id text, user_id uuid, tg_id text, display_name text, model_id text, model_openrouter_id text, model_display_name text, catalog_version integer, pricing_config_version integer, usage_cost_usd numeric, exchange_rate numeric, model_markup numeric, initial_amount numeric, calculated_amount numeric, charged_amount numeric, fallback_used boolean, status text, debit_ledger_id uuid, created_at timestamp with time zone, updated_at timestamp with time zone, reconciled_at timestamp with time zone, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  PERFORM admin.analytics_require_access(true);
  IF p_limit NOT BETWEEN 1 AND 100 OR p_offset NOT BETWEEN 0 AND 10000
     OR p_from IS NULL OR p_to IS NULL OR p_from >= p_to
     OR p_to - p_from > interval '366 days' THEN
    RAISE EXCEPTION 'LLM spending query is outside the allowed range'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    charge.id, charge.charge_key, charge.generation_id, charge.user_id,
    users.tg_id, COALESCE(settings.display_name, settings.tg_username),
    charge.model_id, charge.model_openrouter_id, charge.model_display_name,
    charge.catalog_version, charge.pricing_config_version,
    charge.usage_cost_usd, charge.exchange_rate, charge.model_markup,
    charge.initial_amount, charge.calculated_amount, charge.charged_amount,
    charge.fallback_used, charge.status, charge.debit_ledger_id,
    charge.created_at, charge.updated_at, charge.reconciled_at,
    count(*) OVER ()
  FROM miniapp.llm_usage_charges AS charge
  JOIN miniapp.users AS users ON users.id = charge.user_id
  LEFT JOIN miniapp.miniapp_user_settings AS settings ON settings.user_id = charge.user_id
  WHERE charge.created_at >= p_from
    AND charge.created_at < p_to
    AND (p_model IS NULL OR trim(p_model) = ''
      OR charge.model_id = p_model OR charge.model_openrouter_id = p_model)
    AND (p_fallback IS NULL OR charge.fallback_used = p_fallback)
    AND (p_status IS NULL OR trim(p_status) = '' OR charge.status = p_status)
    AND (
      p_search IS NULL OR trim(p_search) = ''
      OR users.tg_id ILIKE '%' || trim(p_search) || '%'
      OR charge.user_id::TEXT ILIKE '%' || trim(p_search) || '%'
      OR COALESCE(settings.display_name, '') ILIKE '%' || trim(p_search) || '%'
      OR charge.model_display_name ILIKE '%' || trim(p_search) || '%'
      OR charge.model_openrouter_id ILIKE '%' || trim(p_search) || '%'
      OR charge.charge_key::TEXT ILIKE '%' || trim(p_search) || '%'
      OR COALESCE(charge.generation_id, '') ILIKE '%' || trim(p_search) || '%'
    )
  ORDER BY charge.created_at DESC, charge.id
  LIMIT p_limit OFFSET p_offset;
END;
$function$
;

-- ============================================================
-- admin.list_platform_preset_model_assignments()
-- ============================================================
CREATE OR REPLACE FUNCTION admin.list_platform_preset_model_assignments()
 RETURNS TABLE(model_id text, display_name text, sort_order integer, preset_id uuid, assigned_preset_display_name text, effective_preset_id uuid, effective_preset_display_name text, preset_source text, preset_config_code text, assignment_updated_at timestamp with time zone, assignment_version bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'admin is not permitted to access current environment'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH catalog AS (
    SELECT runtime.value
    FROM miniapp.runtime_config AS runtime
    WHERE runtime.key = 'llm_model_catalog'
  ),
  models AS (
    SELECT
      trim(model ->> 'id') AS model_id,
      model ->> 'display_name' AS display_name,
      COALESCE((model ->> 'sort_order')::INTEGER, 0) AS sort_order
    FROM catalog
    CROSS JOIN LATERAL jsonb_array_elements(catalog.value -> 'tiers') AS tier
    CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
    WHERE model -> 'enabled' = 'true'::JSONB
  ),
  default_preset AS (
    SELECT preset.id, preset.display_name
    FROM st_platform.platform_presets AS preset
    WHERE preset.is_default
      AND preset.enabled
    LIMIT 1
  )
  SELECT
    models.model_id,
    models.display_name,
    models.sort_order,
    assignment.preset_id,
    assigned_preset.display_name,
    CASE
      WHEN assigned_preset.enabled THEN assigned_preset.id
      ELSE default_preset.id
    END,
    CASE
      WHEN assigned_preset.enabled THEN assigned_preset.display_name
      ELSE default_preset.display_name
    END,
    CASE
      WHEN assigned_preset.enabled THEN 'model'::TEXT
      WHEN default_preset.id IS NOT NULL THEN 'default'::TEXT
      ELSE NULL
    END,
    CASE
      WHEN assigned_preset.enabled THEN 'OK'::TEXT
      WHEN assignment.preset_id IS NOT NULL AND default_preset.id IS NOT NULL
        THEN 'ASSIGNMENT_INVALID_FALLBACK'::TEXT
      WHEN default_preset.id IS NULL THEN 'NO_ENABLED_DEFAULT'::TEXT
      ELSE 'OK'::TEXT
    END,
    COALESCE(assignment.updated_at, latest_event.created_at),
    state.version
  FROM models
  CROSS JOIN st_platform.platform_preset_model_assignment_state AS state
  LEFT JOIN st_platform.platform_preset_model_assignments AS assignment
    ON assignment.model_id = models.model_id
  LEFT JOIN st_platform.platform_presets AS assigned_preset
    ON assigned_preset.id = assignment.preset_id
  LEFT JOIN LATERAL (
    SELECT event.created_at
    FROM st_platform.platform_preset_model_assignment_events AS event
    WHERE event.model_id = models.model_id
    ORDER BY event.created_at DESC
    LIMIT 1
  ) AS latest_event ON true
  LEFT JOIN default_preset ON true
  ORDER BY models.sort_order, models.display_name, models.model_id;
END;
$function$
;

-- ============================================================
-- admin.list_platform_preset_versions(p_limit integer)
-- ============================================================
CREATE OR REPLACE FUNCTION admin.list_platform_preset_versions(p_limit integer DEFAULT 30)
 RETURNS TABLE(platform_version bigint, preset_id uuid, preset_pointer text, preset_display_name text, created_by text, note text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'admin is not permitted to access current environment'
      USING ERRCODE = '42501';
  END IF;

  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'version history limit must be between 1 and 100'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    settings.platform_version,
    CASE
      WHEN pointer.value ~ '^platform_[0-9a-fA-F-]{36}$'
        THEN substring(pointer.value FROM 10)::UUID
      ELSE NULL
    END AS preset_id,
    pointer.value AS preset_pointer,
    preset.display_name,
    settings.created_by,
    settings.note,
    settings.created_at
  FROM st_platform.platform_settings AS settings
  CROSS JOIN LATERAL (
    SELECT settings.settings_jsonb #>> '{oai_settings,preset_settings_openai}' AS value
  ) AS pointer
  LEFT JOIN st_platform.platform_presets AS preset
    ON pointer.value = 'platform_' || preset.id::TEXT
  WHERE pointer.value IS NOT NULL
  ORDER BY settings.platform_version DESC
  LIMIT p_limit;
END;
$function$
;

-- ============================================================
-- admin.list_platform_presets()
-- ============================================================
CREATE OR REPLACE FUNCTION admin.list_platform_presets()
 RETURNS TABLE(id uuid, display_name text, preset_payload jsonb, is_default boolean, sort_order integer, enabled boolean, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'admin is not permitted to access current environment'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    preset.id,
    preset.display_name,
    preset.preset_payload,
    preset.is_default,
    preset.sort_order,
    preset.enabled,
    preset.created_at,
    preset.updated_at
  FROM st_platform.platform_presets AS preset
  ORDER BY preset.is_default DESC, preset.enabled DESC, preset.sort_order, preset.created_at DESC;
END;
$function$
;

-- ============================================================
-- admin.publish_platform_preset(p_display_name text, p_preset_payload jsonb)
-- ============================================================
CREATE OR REPLACE FUNCTION admin.publish_platform_preset(p_display_name text, p_preset_payload jsonb)
 RETURNS st_platform.platform_presets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_name TEXT;
  v_before st_platform.platform_presets%ROWTYPE;
  v_created st_platform.platform_presets%ROWTYPE;
  v_version BIGINT;
BEGIN
  SELECT admin_user.* INTO v_actor
  FROM admin.admin_users AS admin_user
  WHERE admin_user.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  v_name := trim(COALESCE(p_display_name, ''));
  IF char_length(v_name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'preset display name must contain 1 to 80 characters'
      USING ERRCODE = '22023';
  END IF;
  PERFORM admin.validate_platform_preset_payload(p_preset_payload);

  -- Serialize default promotions so the partial unique index and version increment
  -- cannot race when two operators publish at the same time.
  PERFORM pg_advisory_xact_lock(hashtext('st_platform.platform_presets.default'));

  SELECT preset.* INTO v_before
  FROM st_platform.platform_presets AS preset
  WHERE preset.is_default
  FOR UPDATE;

  IF NOT EXISTS (SELECT 1 FROM st_platform.platform_settings) THEN
    RAISE EXCEPTION 'platform settings must be initialized before publishing a preset'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO st_platform.platform_presets (
    display_name, preset_payload, is_default, sort_order, enabled
  ) VALUES (
    v_name,
    p_preset_payload,
    true,
    COALESCE((SELECT max(preset.sort_order) + 1 FROM st_platform.platform_presets AS preset), 0),
    true
  )
  RETURNING * INTO v_created;

  SELECT max(settings.platform_version)
  INTO v_version
  FROM st_platform.platform_settings AS settings;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    'platform_preset.publish_default', 'st_platform', 'platform_presets', v_created.id::TEXT,
    CASE WHEN v_before.id IS NULL THEN NULL ELSE to_jsonb(v_before) - 'preset_payload' END,
    (to_jsonb(v_created) - 'preset_payload') || jsonb_build_object('platform_version', v_version)
  );

  RETURN v_created;
END;
$function$
;

-- ============================================================
-- admin.rewrite_model_catalog_is_free(p_value jsonb)
-- ============================================================
CREATE OR REPLACE FUNCTION admin.rewrite_model_catalog_is_free(p_value jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT CASE
    WHEN jsonb_typeof(p_value -> 'tiers') IS DISTINCT FROM 'array' THEN p_value
    ELSE jsonb_set(
      p_value,
      '{tiers}',
      (
        SELECT COALESCE(jsonb_agg(
          (tier - 'models') || jsonb_build_object(
            'models',
            (
              SELECT COALESCE(jsonb_agg(
                (model - 'markup' - 'deduct_markup') || jsonb_build_object(
                  'is_free',
                  CASE
                    WHEN jsonb_typeof(model -> 'is_free') = 'boolean' THEN model -> 'is_free'
                    WHEN jsonb_typeof(model -> 'markup') = 'number'
                      THEN to_jsonb((model ->> 'markup')::NUMERIC = 0)
                    ELSE 'false'::jsonb
                  END
                )
                ORDER BY model_ordinality
              ), '[]'::JSONB)
              FROM jsonb_array_elements(COALESCE(tier -> 'models', '[]'::JSONB))
                WITH ORDINALITY AS models(model, model_ordinality)
            )
          )
          ORDER BY tier_ordinality
        ), '[]'::JSONB)
        FROM jsonb_array_elements(p_value -> 'tiers')
          WITH ORDINALITY AS tiers(tier, tier_ordinality)
      ),
      false
    )
  END;
$function$
;

-- ============================================================
-- admin.set_platform_preset_enabled(p_preset_id uuid, p_enabled boolean)
-- ============================================================
CREATE OR REPLACE FUNCTION admin.set_platform_preset_enabled(p_preset_id uuid, p_enabled boolean)
 RETURNS st_platform.platform_presets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_before st_platform.platform_presets%ROWTYPE;
  v_after st_platform.platform_presets%ROWTYPE;
BEGIN
  SELECT admin_user.* INTO v_actor
  FROM admin.admin_users AS admin_user
  WHERE admin_user.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  SELECT preset.* INTO v_before
  FROM st_platform.platform_presets AS preset
  WHERE preset.id = p_preset_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform preset not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_before.is_default AND NOT COALESCE(p_enabled, false) THEN
    RAISE EXCEPTION 'the current default preset cannot be disabled'
      USING ERRCODE = '22023';
  END IF;

  UPDATE st_platform.platform_presets
  SET enabled = COALESCE(p_enabled, false),
      updated_at = now()
  WHERE id = p_preset_id
  RETURNING * INTO v_after;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    CASE WHEN v_after.enabled
      THEN 'platform_preset.enable'
      ELSE 'platform_preset.disable'
    END,
    'st_platform', 'platform_presets', p_preset_id::TEXT,
    to_jsonb(v_before) - 'preset_payload', to_jsonb(v_after) - 'preset_payload'
  );

  RETURN v_after;
END;
$function$
;

-- ============================================================
-- admin.update_platform_preset_metadata(p_preset_id uuid, p_display_name text, p_sort_order integer)
-- ============================================================
CREATE OR REPLACE FUNCTION admin.update_platform_preset_metadata(p_preset_id uuid, p_display_name text, p_sort_order integer)
 RETURNS st_platform.platform_presets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_before st_platform.platform_presets%ROWTYPE;
  v_after st_platform.platform_presets%ROWTYPE;
  v_name TEXT;
BEGIN
  SELECT admin_user.* INTO v_actor
  FROM admin.admin_users AS admin_user
  WHERE admin_user.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  v_name := trim(COALESCE(p_display_name, ''));
  IF char_length(v_name) NOT BETWEEN 1 AND 80 OR p_sort_order IS NULL OR p_sort_order < 0 THEN
    RAISE EXCEPTION 'invalid preset metadata' USING ERRCODE = '22023';
  END IF;

  SELECT preset.* INTO v_before
  FROM st_platform.platform_presets AS preset
  WHERE preset.id = p_preset_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform preset not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE st_platform.platform_presets
  SET display_name = v_name,
      sort_order = p_sort_order,
      updated_at = now()
  WHERE id = p_preset_id
  RETURNING * INTO v_after;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    'platform_preset.metadata_update', 'st_platform', 'platform_presets', p_preset_id::TEXT,
    to_jsonb(v_before) - 'preset_payload', to_jsonb(v_after) - 'preset_payload'
  );

  RETURN v_after;
END;
$function$
;

-- ============================================================
-- admin.update_platform_preset_model_assignment(p_model_id text, p_preset_id uuid, p_expected_version bigint)
-- ============================================================
CREATE OR REPLACE FUNCTION admin.update_platform_preset_model_assignment(p_model_id text, p_preset_id uuid, p_expected_version bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_model_id TEXT := trim(COALESCE(p_model_id, ''));
  v_preset st_platform.platform_presets%ROWTYPE;
  v_before_preset_id UUID;
  v_current_version BIGINT;
  v_version BIGINT;
BEGIN
  SELECT admin_user.* INTO v_actor
  FROM admin.admin_users AS admin_user
  WHERE admin_user.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('st_platform.platform_preset_model_assignments', 0)
  );

  SELECT state.version INTO v_current_version
  FROM st_platform.platform_preset_model_assignment_state AS state
  WHERE state.singleton
  FOR UPDATE;

  IF p_expected_version IS NULL OR p_expected_version <> v_current_version THEN
    RAISE EXCEPTION '模型预设分配已被其他运营更新，请刷新后重试'
      USING ERRCODE = '40001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM miniapp.runtime_config AS runtime
    CROSS JOIN LATERAL jsonb_array_elements(runtime.value -> 'tiers') AS tier
    CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
    WHERE runtime.key = 'llm_model_catalog'
      AND trim(model ->> 'id') = v_model_id
      AND model -> 'enabled' = 'true'::JSONB
  ) THEN
    RAISE EXCEPTION '所选模型不存在或已停用，请刷新模型目录后重试'
      USING ERRCODE = '22023';
  END IF;

  IF p_preset_id IS NOT NULL THEN
    SELECT preset.* INTO v_preset
    FROM st_platform.platform_presets AS preset
    WHERE preset.id = p_preset_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'platform preset not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT v_preset.enabled THEN
      RAISE EXCEPTION '已停用的预设不能分配给模型'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT assignment.preset_id INTO v_before_preset_id
  FROM st_platform.platform_preset_model_assignments AS assignment
  WHERE assignment.model_id = v_model_id
  FOR UPDATE;

  IF v_before_preset_id IS NOT DISTINCT FROM p_preset_id THEN
    RETURN v_current_version;
  END IF;

  INSERT INTO st_platform.platform_preset_model_assignment_events (
    model_id,
    before_preset_id,
    after_preset_id,
    action,
    actor_user_id,
    actor_email
  ) VALUES (
    v_model_id,
    v_before_preset_id,
    p_preset_id,
    CASE
      WHEN p_preset_id IS NULL THEN 'clear'
      WHEN v_before_preset_id IS NULL THEN 'assign'
      ELSE 'reassign'
    END,
    v_actor.user_id,
    v_actor.email
  );

  IF p_preset_id IS NULL THEN
    DELETE FROM st_platform.platform_preset_model_assignments AS assignment
    WHERE assignment.model_id = v_model_id;
  ELSE
    INSERT INTO st_platform.platform_preset_model_assignments (
      model_id,
      preset_id,
      updated_by,
      updated_at
    ) VALUES (
      v_model_id,
      p_preset_id,
      v_actor.user_id,
      now()
    )
    ON CONFLICT (model_id) DO UPDATE
    SET preset_id = EXCLUDED.preset_id,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at;
  END IF;

  UPDATE st_platform.platform_preset_model_assignment_state
  SET version = version + 1,
      updated_by = v_actor.user_id,
      updated_at = now()
  WHERE singleton
  RETURNING version INTO v_version;

  INSERT INTO admin.audit_logs (
    actor_user_id,
    actor_email,
    environment,
    action,
    schema_name,
    table_name,
    record_id,
    before_value,
    after_value
  ) VALUES (
    v_actor.user_id,
    v_actor.email,
    admin.current_environment(),
    'platform_preset.model_assignment_update',
    'st_platform',
    'platform_preset_model_assignments',
    v_model_id,
    jsonb_build_object('preset_id', v_before_preset_id),
    jsonb_build_object('preset_id', p_preset_id, 'assignment_version', v_version)
  );

  RETURN v_version;
END;
$function$
;

-- ============================================================
-- admin.update_platform_preset_model_assignments(p_preset_id uuid, p_model_ids text[], p_expected_version bigint)
-- ============================================================
CREATE OR REPLACE FUNCTION admin.update_platform_preset_model_assignments(p_preset_id uuid, p_model_ids text[], p_expected_version bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_preset st_platform.platform_presets%ROWTYPE;
  v_model_ids TEXT[];
  v_model_id TEXT;
  v_before_preset_id UUID;
  v_before_model_ids TEXT[];
  v_changed BOOLEAN := false;
  v_current_version BIGINT;
  v_version BIGINT;
BEGIN
  SELECT admin_user.* INTO v_actor
  FROM admin.admin_users AS admin_user
  WHERE admin_user.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  SELECT ARRAY(
    SELECT DISTINCT trim(candidate)
    FROM unnest(COALESCE(p_model_ids, ARRAY[]::TEXT[])) AS candidate
    WHERE char_length(trim(candidate)) > 0
    ORDER BY trim(candidate)
  ) INTO v_model_ids;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('st_platform.platform_preset_model_assignments', 0)
  );

  SELECT state.version INTO v_current_version
  FROM st_platform.platform_preset_model_assignment_state AS state
  WHERE state.singleton
  FOR UPDATE;

  IF p_expected_version IS NULL OR p_expected_version <> v_current_version THEN
    RAISE EXCEPTION '模型预设分配已被其他运营更新，请刷新后重试'
      USING ERRCODE = '40001';
  END IF;

  SELECT preset.* INTO v_preset
  FROM st_platform.platform_presets AS preset
  WHERE preset.id = p_preset_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform preset not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_preset.enabled AND cardinality(v_model_ids) > 0 THEN
    RAISE EXCEPTION '已停用的预设不能分配给模型'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(v_model_ids) AS requested(model_id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM miniapp.runtime_config AS runtime
      CROSS JOIN LATERAL jsonb_array_elements(runtime.value -> 'tiers') AS tier
      CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
      WHERE runtime.key = 'llm_model_catalog'
        AND trim(model ->> 'id') = requested.model_id
        AND model -> 'enabled' = 'true'::JSONB
    )
  ) THEN
    RAISE EXCEPTION '所选模型不存在或已停用，请刷新模型目录后重试'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(assignment.model_id ORDER BY assignment.model_id), ARRAY[]::TEXT[])
  INTO v_before_model_ids
  FROM st_platform.platform_preset_model_assignments AS assignment
  WHERE assignment.preset_id = p_preset_id;

  INSERT INTO st_platform.platform_preset_model_assignment_events (
    model_id, before_preset_id, after_preset_id, action,
    actor_user_id, actor_email
  )
  SELECT
    assignment.model_id,
    assignment.preset_id,
    NULL,
    'clear',
    v_actor.user_id,
    v_actor.email
  FROM st_platform.platform_preset_model_assignments AS assignment
  WHERE assignment.preset_id = p_preset_id
    AND NOT (assignment.model_id = ANY(v_model_ids));

  DELETE FROM st_platform.platform_preset_model_assignments AS assignment
  WHERE assignment.preset_id = p_preset_id
    AND NOT (assignment.model_id = ANY(v_model_ids));

  IF FOUND THEN
    v_changed := true;
  END IF;

  FOREACH v_model_id IN ARRAY v_model_ids LOOP
    SELECT assignment.preset_id INTO v_before_preset_id
    FROM st_platform.platform_preset_model_assignments AS assignment
    WHERE assignment.model_id = v_model_id
    FOR UPDATE;

    IF v_before_preset_id IS NOT DISTINCT FROM p_preset_id THEN
      CONTINUE;
    END IF;

    INSERT INTO st_platform.platform_preset_model_assignment_events (
      model_id, before_preset_id, after_preset_id, action,
      actor_user_id, actor_email
    ) VALUES (
      v_model_id,
      v_before_preset_id,
      p_preset_id,
      CASE WHEN v_before_preset_id IS NULL THEN 'assign' ELSE 'reassign' END,
      v_actor.user_id,
      v_actor.email
    );

    INSERT INTO st_platform.platform_preset_model_assignments (
      model_id, preset_id, updated_by, updated_at
    ) VALUES (
      v_model_id, p_preset_id, v_actor.user_id, now()
    )
    ON CONFLICT (model_id) DO UPDATE
    SET preset_id = EXCLUDED.preset_id,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at;

    v_changed := true;
  END LOOP;

  IF v_changed THEN
    UPDATE st_platform.platform_preset_model_assignment_state
    SET version = version + 1,
        updated_by = v_actor.user_id,
        updated_at = now()
    WHERE singleton
    RETURNING version INTO v_version;

    INSERT INTO admin.audit_logs (
      actor_user_id, actor_email, environment, action, schema_name,
      table_name, record_id, before_value, after_value
    ) VALUES (
      v_actor.user_id,
      v_actor.email,
      admin.current_environment(),
      'platform_preset.model_assignments_update',
      'st_platform',
      'platform_preset_model_assignments',
      p_preset_id::TEXT,
      jsonb_build_object('model_ids', v_before_model_ids),
      jsonb_build_object('model_ids', v_model_ids, 'assignment_version', v_version)
    );
  ELSE
    v_version := v_current_version;
  END IF;

  RETURN v_version;
END;
$function$
;

