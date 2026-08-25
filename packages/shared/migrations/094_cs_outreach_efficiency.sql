-- 094_cs_outreach_efficiency.sql
--
-- CS 平台回访效率优化，四件事的库侧支撑：
--   3.1 会话按最新用户消息排序 → 视图补 last_user_message_at
--   3.2 聊天页特殊标记与备注   → persona_member_state 补 special_note 三列
--   3.3 首轮/二次等待状态区分   → 视图补 waiting_state
--   3.4 按簇与状态群发         → 复用上面的 waiting_state 做筛选，无新表
--
-- 顺带把 cs_platform 的两个视图整个重建一遍。这不是多余动作：生产库上
-- user_metrics 与 persona_users_detail 都已经不存在了（在迁移文件之外被删掉的，
-- 仓库里没有任何一条迁移删过它们），导致回访平台的用户列表对所有画像簇都取不到数据。
-- 本次要改 persona_users_detail，而它 JOIN 了 user_metrics，所以两个都得先在场，
-- 否则这条迁移在生产库上会直接报 relation does not exist。
--
-- user_metrics 的定义与 028 逐字一致，不含任何 public.* 依赖（024 的老定义读
-- public.messages，那张 ST 遗留表已经不在了）；重建后再清 ST 遗留对象不会二次带走它。
--
-- 幂等：ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE VIEW，可重复执行。
-- 注意 CREATE OR REPLACE VIEW 只允许在末尾追加列，所以新列一律加在最后，
-- 不要为了好看去调整既有列的顺序，那会让这条迁移在已有视图的库上失败。

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ─── 1. 特殊标记与备注（3.2）────────────────────────────────────────────────
-- 挂在 persona_member_state 而不是新建一张表：备注的粒度就是「这个簇里的这个用户」，
-- 与 left_note 同域，且刷新成员时这行本来就在，不会因为重新刷簇把备注冲掉。
ALTER TABLE cs_platform.persona_member_state
  ADD COLUMN IF NOT EXISTS special_note TEXT,
  ADD COLUMN IF NOT EXISTS special_note_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS special_note_operator_id TEXT;

COMMENT ON COLUMN cs_platform.persona_member_state.special_note IS
  '客服在聊天页右上角「特殊标记」里填的备注：用户问题、承诺的处理动作或二次回访提醒。'
  'NULL 或空串表示未标记。与 left_note 不同——left_note 是系统写的移出说明，这一列是客服手写的。';
COMMENT ON COLUMN cs_platform.persona_member_state.special_note_updated_at IS
  '备注最后一次保存时间。清空备注时一并置 NULL，等价于取消标记。';
COMMENT ON COLUMN cs_platform.persona_member_state.special_note_operator_id IS
  '最后一次保存备注的客服操作人标识，取自 X-CS-Operator-Id。';

-- ─── 2. 重建 user_metrics（生产库缺失修复，定义同 028）──────────────────────
CREATE OR REPLACE VIEW cs_platform.user_metrics AS
WITH payment_summary AS (
  SELECT
    user_id,
    count(*) FILTER (WHERE status = 'completed')::INTEGER AS paid_count,
    COALESCE(sum(amount_cents) FILTER (WHERE status = 'completed'), 0)::INTEGER AS paid_cents
  FROM miniapp.payment_orders
  GROUP BY user_id
),
message_activity AS (
  SELECT
    user_id,
    max(created_at) AS last_message_at
  FROM miniapp.chat_history
  GROUP BY user_id
)
SELECT
  u.id AS user_id,
  u.tg_id AS telegram_user_id,
  COALESCE(NULLIF(s.display_name, ''), NULLIF(s.tg_username, ''), NULLIF(s.tg_first_name, ''), u.tg_id) AS display_name,
  s.tg_username AS username,
  GREATEST(floor(extract(epoch FROM (now() - COALESCE(u.miniapp_entered_at, u.created_at))) / 86400)::INTEGER, 0) AS register_days,
  COALESCE(w.total_paid_amount, 0)::NUMERIC(12, 2) AS total_paid_amount,
  COALESCE(p.paid_count, 0)::INTEGER AS paid_count,
  COALESCE(u.total_round, s.total_round, 0)::BIGINT AS total_round,
  COALESCE(m.last_message_at, s.updated_at, u.updated_at, u.miniapp_entered_at, u.created_at) AS last_active_at
FROM miniapp.users u
LEFT JOIN miniapp.miniapp_user_settings s ON s.user_id = u.id
LEFT JOIN miniapp.user_wallets w ON w.user_id = u.id
LEFT JOIN payment_summary p ON p.user_id = u.id
LEFT JOIN message_activity m ON m.user_id = u.id;

-- ─── 3. persona_users_detail 补排序键、等待状态与备注 ───────────────────────
--
-- 等待状态口径（3.3）：
--   first_round  黄：用户发过消息，客服在这个会话里一句都没成功发出去 → 必须优先处理
--   second_round 绿：客服至少成功发出过一句，且用户也发过消息 → 正常跟进中
--   none        无：用户一句没发过（含只发了破冰、还没等到回复）→ 不属于「等我回」
--
-- 只把 send_status = 'sent' 算作「客服回过」：failed 是没送达，pending 是在途，
-- 这两种情况下用户那边什么都没收到，仍然应该是黄色。
--
-- 排序键（3.1）用 last_user_message_at，一次性时间排序，不是永久置顶：
-- 谁的最新用户消息更晚谁在前，后面任何人来了更晚的消息，原会话自然下移。
CREATE OR REPLACE VIEW cs_platform.persona_users_detail AS
SELECT
  ms.persona_id,
  ms.user_id,
  um.telegram_user_id,
  um.display_name,
  um.username,
  um.register_days,
  um.total_paid_amount,
  um.paid_count,
  um.total_round,
  um.last_active_at,
  ms.membership_status,
  COALESCE(os.status, 'not_started') AS session_status,
  os.current_stage,
  os.current_question_key,
  ms.last_contacted_at AS chatted_at,
  ms.left_note,
  msg.last_user_message_at,
  msg.last_agent_message_at,
  CASE
    WHEN COALESCE(msg.user_message_count, 0) = 0 THEN 'none'
    WHEN COALESCE(msg.agent_sent_count, 0) = 0 THEN 'first_round'
    ELSE 'second_round'
  END AS waiting_state,
  ms.special_note,
  ms.special_note_updated_at
FROM cs_platform.persona_member_state ms
JOIN cs_platform.user_metrics um ON um.user_id = ms.user_id
LEFT JOIN cs_platform.outreach_sessions os
  ON os.persona_id = ms.persona_id AND os.user_id = ms.user_id
LEFT JOIN (
  SELECT
    persona_id,
    user_id,
    max(created_at) FILTER (WHERE direction = 'user') AS last_user_message_at,
    max(created_at) FILTER (WHERE direction = 'agent' AND send_status = 'sent')
      AS last_agent_message_at,
    count(*) FILTER (WHERE direction = 'user') AS user_message_count,
    count(*) FILTER (WHERE direction = 'agent' AND send_status = 'sent') AS agent_sent_count
  FROM cs_platform.outreach_messages
  GROUP BY persona_id, user_id
) msg ON msg.persona_id = ms.persona_id AND msg.user_id = ms.user_id;

-- 上面的聚合子查询按 (persona_id, user_id) 分组，024 建的
-- (persona_id, user_id, created_at DESC) 索引已经能覆盖；direction / send_status
-- 是 FILTER 里的条件，选择性不高，再加复合索引收益有限，先不加。

COMMIT;

NOTIFY pgrst, 'reload schema';

-- 验证：
--   -- 两个视图都应在
--   SELECT table_name FROM information_schema.views WHERE table_schema = 'cs_platform';
--   -- 新列都应在
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema = 'cs_platform' AND table_name = 'persona_users_detail'
--      AND column_name IN ('last_user_message_at','last_agent_message_at','waiting_state',
--                          'special_note','special_note_updated_at');
--   -- 等待状态取值只能是这三个
--   SELECT DISTINCT waiting_state FROM cs_platform.persona_users_detail;
--
-- 回滚：
--   BEGIN;
--   -- 先把视图降回 024/028 的列集合（CREATE OR REPLACE 不能删列，必须先 DROP）
--   DROP VIEW IF EXISTS cs_platform.persona_users_detail;
--   -- 然后执行 024 里的 persona_users_detail 定义
--   ALTER TABLE cs_platform.persona_member_state
--     DROP COLUMN IF EXISTS special_note,
--     DROP COLUMN IF EXISTS special_note_updated_at,
--     DROP COLUMN IF EXISTS special_note_operator_id;
--   COMMIT;
