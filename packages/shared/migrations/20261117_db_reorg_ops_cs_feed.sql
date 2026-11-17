-- Domain: ops（新建：工程观测）+ cs_feed（新建：给客服仓库读的只读视图层）。
-- 数据库重组阶段 1a，规则见 docs/db/CONTRACT.md，计划见 .trellis/tasks/11-17-db-reorg-p1-foundation/design.md。
--
-- 只新增，不改动已有对象：
--   1) ops：空 schema，阶段 2 起承接上游调用明细、测速、事件、告警。只给 service_role；
--      外部读者以后经 miniapp_analytics 视图读取，不直接授权 ops。
--   2) cs_feed：客服仓库 ST_cs_platform 今天直读 app_core / billing / experience 的 7 张表。
--      这里提供两个视图，输出列与客服现有查询口径一一对应（users.ts profileSelect、
--      conversations.ts summarySelect、outreach.ts、alerts.ts）。之后内部拆表只改视图定义、
--      不改输出列，客服不受影响。视图归 postgres（BYPASSRLS），与 analytics_grafana 现有视图同法，
--      客服账号只需视图 SELECT；对业务表的直接授权在阶段 1c 收回。
--      cs_feed 不暴露给 PostgREST。
--
-- Prerequisite: app_core.users / miniapp_user_settings、billing.user_wallets / vip_memberships /
--   payment_orders、experience.chat_sessions。cs_runtime_v1 / cs_persona_reader 只在生产存在，按存在授权。
-- Verify: bash scripts/test-db-reorg-p1a-migration.sh（PG17：两次幂等、视图结果与客服原 SQL 逐行一致、
--   客服账号无底表权限也能读视图）。
-- Release: TEST -> Production -> 客服仓库改读 cs_feed（阶段 1b）-> 收权（阶段 1c）。
-- Recovery: 客服仓库未切换前可直接 `DROP SCHEMA cs_feed CASCADE; DROP SCHEMA ops;`；切换后先回退客服仓库。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('app_core.users') IS NULL
     OR to_regclass('app_core.miniapp_user_settings') IS NULL
     OR to_regclass('billing.user_wallets') IS NULL
     OR to_regclass('billing.vip_memberships') IS NULL
     OR to_regclass('billing.payment_orders') IS NULL
     OR to_regclass('experience.chat_sessions') IS NULL THEN
    RAISE EXCEPTION 'cs_feed source tables missing';
  END IF;
END $preflight$;

-- ───────────── ops ─────────────
CREATE SCHEMA IF NOT EXISTS ops;
COMMENT ON SCHEMA ops IS
  '工程观测：上游调用明细、测速、事件、告警。删掉不影响用户结果与扣费；产品请求路径不读；外部读者经 miniapp_analytics 视图读。规则见 docs/db/CONTRACT.md';
REVOKE ALL ON SCHEMA ops FROM PUBLIC;
GRANT USAGE ON SCHEMA ops TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA ops REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ───────────── cs_feed ─────────────
CREATE SCHEMA IF NOT EXISTS cs_feed;
COMMENT ON SCHEMA cs_feed IS
  '本仓库维护、给客服仓库 ST_cs_platform 读的只读视图。内部表结构变化时同 PR 改视图定义，输出列保持不变。规则见 docs/db/CONTRACT.md §2.6';
REVOKE ALL ON SCHEMA cs_feed FROM PUBLIC;
GRANT USAGE ON SCHEMA cs_feed TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA cs_feed REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- 对话列表、回访名单、告警只要身份与名字，不带聚合。
CREATE OR REPLACE VIEW cs_feed.user_identities WITH (security_barrier = true) AS
SELECT u.id AS user_id,
       u.tg_id,
       COALESCE(NULLIF(s.display_name, ''), NULLIF(s.tg_username, ''), NULLIF(s.tg_first_name, '')) AS display_name,
       NULLIF(s.tg_username, '') AS username
FROM app_core.users u
LEFT JOIN app_core.miniapp_user_settings s ON s.user_id = u.id;

COMMENT ON VIEW cs_feed.user_identities IS
  '客服用：用户身份与展示名（展示名优先级 display_name > tg_username > tg_first_name）。';

-- 客服工作台的用户资料卡；口径与客服仓库 users.ts profileSelect 一致。
CREATE OR REPLACE VIEW cs_feed.user_profiles WITH (security_barrier = true) AS
SELECT i.user_id,
       i.tg_id,
       i.display_name,
       i.username,
       u.source_id,
       COALESCE(u.miniapp_entered_at, u.created_at) AS registered_at,
       v.valid_until AS vip_valid_until,
       COALESCE(w.total_paid_amount, 0)::numeric(12, 2) AS total_paid_amount,
       COALESCE(p.paid_count, 0)::integer AS paid_count,
       COALESCE(w.first_paid_at, p.first_paid_at) AS first_paid_at,
       COALESCE(w.last_paid_at, p.last_paid_at) AS last_paid_at,
       (COALESCE(w.main_credits, 0) + COALESCE(w.bonus_credits, 0))::numeric(14, 2) AS credits_balance,
       COALESCE(u.total_round, s.total_round, 0)::bigint AS total_rounds,
       cs_last.last_message_at AS last_chat_at
FROM cs_feed.user_identities i
JOIN app_core.users u ON u.id = i.user_id
LEFT JOIN app_core.miniapp_user_settings s ON s.user_id = i.user_id
LEFT JOIN billing.user_wallets w ON w.user_id = i.user_id
LEFT JOIN billing.vip_memberships v ON v.user_id = i.user_id
LEFT JOIN LATERAL (
  SELECT count(*) AS paid_count, min(o.paid_at) AS first_paid_at, max(o.paid_at) AS last_paid_at
  FROM billing.payment_orders o
  WHERE o.user_id = i.user_id AND o.status = 'completed'
) p ON true
LEFT JOIN LATERAL (
  SELECT cs.last_message_at
  FROM experience.chat_sessions cs
  WHERE cs.user_id = i.user_id AND cs.deleted_at IS NULL
  ORDER BY cs.last_message_at DESC NULLS LAST
  LIMIT 1
) cs_last ON true;

COMMENT ON VIEW cs_feed.user_profiles IS
  '客服用：用户资料卡。total_paid_amount 为元；paid_count 数 completed 订单；registered_at 优先首次进入 MiniApp 时间；按 user_id 或 tg_id 过滤使用。';

REVOKE ALL ON cs_feed.user_identities, cs_feed.user_profiles FROM PUBLIC;
GRANT SELECT ON cs_feed.user_identities, cs_feed.user_profiles TO service_role;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cs_runtime_v1') THEN
    GRANT USAGE ON SCHEMA cs_feed TO cs_runtime_v1;
    GRANT SELECT ON cs_feed.user_identities, cs_feed.user_profiles TO cs_runtime_v1;
  END IF;
  -- 画像簇的圈人 SQL 以后只写 cs_feed / miniapp_analytics；旧的业务表授权在 1c 收回。
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cs_persona_reader') THEN
    GRANT USAGE ON SCHEMA cs_feed TO cs_persona_reader;
    GRANT SELECT ON cs_feed.user_identities, cs_feed.user_profiles TO cs_persona_reader;
  END IF;
END $grants$;

COMMIT;
