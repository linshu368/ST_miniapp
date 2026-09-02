-- 106: 裂变邀请阶段二：运营台邀请数据明细查询 RPC。
-- domain: acquisition（admin 查询通道，见 docs/schema归属地图.md 与 docs/裂变阶段二实施计划.md E4）
--
-- 背景：105 的 invite 三表开 RLS 且只授 service_role，admin 前端经 /api/admin/supabase
-- 代理持 anon+用户 JWT 直查必被拒。对齐 outreach（066）/ 公告的既有模式：
-- admin schema 下 SECURITY DEFINER RPC，函数内做 admin 鉴权。
--
-- 只做明细查询（PRD 明确不做总邀请数 / 汇总看板），只读，无审计写入。
--
-- 前置：105 已执行（miniapp_traffic.invite_* 三表存在）。
-- 执行：GitHub Actions → Database Migration，先 test；生产与 105 一起推迟到阶段四。

BEGIN;

-- ─── 0. 前置守卫 ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('miniapp_traffic.invite_relations') IS NULL
     OR to_regclass('miniapp_traffic.invite_reward_logs') IS NULL THEN
    RAISE EXCEPTION '缺少 105 的 invite 表，请先执行 105';
  END IF;
  IF to_regprocedure('admin.can_access_environment(text)') IS NULL
     OR to_regprocedure('admin.current_environment()') IS NULL THEN
    RAISE EXCEPTION '缺少 admin 鉴权函数（can_access_environment / current_environment）';
  END IF;
  IF to_regclass('app_core.users') IS NULL
     OR to_regclass('app_core.miniapp_user_settings') IS NULL THEN
    RAISE EXCEPTION '缺少 099 之后的 app_core 布局';
  END IF;
END;
$$;

-- ─── 1. 邀请数据明细查询 ─────────────────────────────────────────────────────
-- 筛选口径（阶段二计划 §2，已确认）：
--   p_inviter_ref / p_invitee_ref：同时匹配用户 UUID 或 tg_id（对齐 066 lookup 的 identifier 习惯）；
--     给定但查无此人时直接返回空集。
--   p_reward_status：'granted'（已有到账）/ 'none'（零到账）/ NULL（不限）。
--   p_bound_from / p_bound_to：绑定时间闭开区间 [from, to)。
--   分页：p_limit 1..200（缺省 50），p_offset >= 0；total_count 为筛选后总行数（窗口函数）。
CREATE OR REPLACE FUNCTION admin.list_invite_records(
  p_inviter_ref TEXT DEFAULT NULL,
  p_invitee_ref TEXT DEFAULT NULL,
  p_bound_from TIMESTAMPTZ DEFAULT NULL,
  p_bound_to TIMESTAMPTZ DEFAULT NULL,
  p_reward_status TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
) RETURNS TABLE (
  relation_id UUID,
  inviter_user_id UUID,
  inviter_tg_id TEXT,
  inviter_display_name TEXT,
  invitee_user_id UUID,
  invitee_tg_id TEXT,
  invitee_display_name TEXT,
  invite_code TEXT,
  bound_at TIMESTAMPTZ,
  reward_credits_total INTEGER,
  reward_entries JSONB,
  total_count BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset INTEGER := GREATEST(COALESCE(p_offset, 0), 0);
  v_status TEXT := NULLIF(trim(COALESCE(p_reward_status, '')), '');
  v_inviter_ref TEXT := NULLIF(trim(COALESCE(p_inviter_ref, '')), '');
  v_invitee_ref TEXT := NULLIF(trim(COALESCE(p_invitee_ref, '')), '');
  v_inviter_id UUID;
  v_invitee_id UUID;
BEGIN
  -- 只读查询：环境权限校验即可（can_access_environment 内部含 admin_users 成员校验，
  -- viewer 亦可查），对齐 admin.list_announcements（066）。
  IF NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'admin is not permitted to access current environment'
      USING ERRCODE = '42501';
  END IF;

  IF v_status IS NOT NULL AND v_status NOT IN ('granted', 'none') THEN
    RAISE EXCEPTION 'reward status must be granted / none / null'
      USING ERRCODE = '22023';
  END IF;

  -- ref → user id：先按 UUID 解析，失败再按 tg_id 精确匹配；查无此人直接空集返回。
  IF v_inviter_ref IS NOT NULL THEN
    v_inviter_id := admin.resolve_invite_user_ref(v_inviter_ref);
    IF v_inviter_id IS NULL THEN
      RETURN;
    END IF;
  END IF;
  IF v_invitee_ref IS NOT NULL THEN
    v_invitee_id := admin.resolve_invite_user_ref(v_invitee_ref);
    IF v_invitee_id IS NULL THEN
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    r.id,
    r.inviter_user_id,
    ui.tg_id,
    COALESCE(si.display_name, si.tg_first_name),
    r.invitee_user_id,
    uv.tg_id,
    COALESCE(sv.display_name, sv.tg_first_name),
    r.invite_code,
    r.bound_at,
    COALESCE(rw.credits_total, 0)::integer,
    COALESCE(rw.entries, '[]'::jsonb),
    count(*) OVER ()
  FROM miniapp_traffic.invite_relations AS r
  JOIN app_core.users AS ui ON ui.id = r.inviter_user_id
  JOIN app_core.users AS uv ON uv.id = r.invitee_user_id
  LEFT JOIN app_core.miniapp_user_settings AS si ON si.user_id = r.inviter_user_id
  LEFT JOIN app_core.miniapp_user_settings AS sv ON sv.user_id = r.invitee_user_id
  LEFT JOIN LATERAL (
    SELECT
      SUM(l.credits) AS credits_total,
      jsonb_agg(
        jsonb_build_object(
          'rule_key', l.rule_key,
          'credits', l.credits,
          'granted_at', l.granted_at
        )
        ORDER BY l.granted_at DESC
      ) AS entries
    FROM miniapp_traffic.invite_reward_logs AS l
    WHERE l.relation_id = r.id
  ) AS rw ON TRUE
  WHERE (v_inviter_id IS NULL OR r.inviter_user_id = v_inviter_id)
    AND (v_invitee_id IS NULL OR r.invitee_user_id = v_invitee_id)
    AND (p_bound_from IS NULL OR r.bound_at >= p_bound_from)
    AND (p_bound_to IS NULL OR r.bound_at < p_bound_to)
    AND (
      v_status IS NULL
      OR (v_status = 'granted' AND rw.credits_total IS NOT NULL)
      OR (v_status = 'none' AND rw.credits_total IS NULL)
    )
  ORDER BY r.bound_at DESC
  LIMIT v_limit OFFSET v_offset;
END;
$$;

-- ref 解析小工具：仅供 list_invite_records 内部使用，因此不 GRANT 给任何客户端角色。
CREATE OR REPLACE FUNCTION admin.resolve_invite_user_ref(p_ref TEXT)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_uuid UUID;
  v_user_id UUID;
BEGIN
  BEGIN
    v_uuid := p_ref::UUID;
  EXCEPTION WHEN invalid_text_representation THEN
    v_uuid := NULL;
  END;

  IF v_uuid IS NOT NULL THEN
    SELECT u.id INTO v_user_id FROM app_core.users AS u WHERE u.id = v_uuid;
  ELSE
    SELECT u.id INTO v_user_id FROM app_core.users AS u WHERE u.tg_id = p_ref;
  END IF;
  RETURN v_user_id;
END;
$$;

COMMENT ON FUNCTION admin.list_invite_records(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, INTEGER) IS
  '运营台裂变邀请数据明细：按邀请人/被邀请用户（UUID 或 tg_id）、绑定时间、奖励状态筛选，服务端分页。只读，不做汇总。';
COMMENT ON FUNCTION admin.resolve_invite_user_ref(TEXT) IS
  'list_invite_records 内部工具：UUID 或 tg_id 解析为用户 id，查无返回 NULL。';

-- ─── 2. 权限（对齐 066：实际鉴权在函数体内） ─────────────────────────────────
REVOKE ALL ON FUNCTION admin.list_invite_records(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.resolve_invite_user_ref(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION admin.list_invite_records(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, INTEGER)
  TO authenticated, service_role, postgres;

-- ─── 3. 自检：断言不成立就让本次迁移失败回滚 ────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('admin.list_invite_records(text,text,timestamptz,timestamptz,text,integer,integer)') IS NULL THEN
    RAISE EXCEPTION '自检失败：list_invite_records 缺失';
  END IF;
  IF has_function_privilege(
       'anon',
       'admin.list_invite_records(text,text,timestamptz,timestamptz,text,integer,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION '自检失败：anon 不应能执行 list_invite_records';
  END IF;
  IF NOT has_function_privilege(
       'authenticated',
       'admin.list_invite_records(text,text,timestamptz,timestamptz,text,integer,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION '自检失败：authenticated 应能执行 list_invite_records（实际鉴权在函数体内）';
  END IF;
  IF has_function_privilege('anon', 'admin.resolve_invite_user_ref(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'admin.resolve_invite_user_ref(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '自检失败：resolve_invite_user_ref 不应暴露给客户端角色';
  END IF;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- 验证（test 库执行后手动跑，需以 admin 用户 JWT 经代理调用，或 psql 内模拟 jwt claims）：
--   SELECT * FROM admin.list_invite_records();                                  -- 最近 50 条明细
--   SELECT * FROM admin.list_invite_records(p_reward_status => 'granted');      -- 仅已到账
--   SELECT * FROM admin.list_invite_records(p_inviter_ref => '<tg_id 或 uuid>');
