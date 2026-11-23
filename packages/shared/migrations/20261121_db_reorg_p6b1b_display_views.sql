-- Domain: experience（消息展示视图）——数据库重组阶段 6b-1b 读方切换（一）：展示视图的每轮扣费额改读 billing.usage_charges。
-- 计划见 .trellis/tasks/11-19-db-reorg-p6-billing/design.md（6b-1b / 6b-1c 拆解）。
--
-- 三个展示视图都输出 deduction_rate（后端映射成 credits_per_turn，畅聊用 0 判断免费轮）：
--   - chat_history_display、session_chat_history 直接读 chat_history.deduction_rate → 改为
--     COALESCE(usage_charges.charged_credits, chat_history.deduction_rate)，按 llm_charge_id 关联；
--   - session_chat_display 读 chat_history_display，跟着生效，不用改。
-- 回退到旧值只为没有计费编号的轮次：10 月前的老数据，以及开轮前被拒、从未计费的轮次（扣费额 0）。
-- 6b-1c 删列前给老数据补计费行，届时去掉回退。有编号的轮次两边逐行相等（6b-1a 镜像，11-21 生产核对差异 0）。
-- 输出列名、类型（numeric(14,1)）、security_invoker 都不变；后端不用改。
-- 本文件（一个 DO 块、一个事务）：守卫当前定义 md5（防止覆盖别人的改动），已切换则跳过；
--   先在底表上全量比对新旧扣费额（不一致就拒绝，不碰视图），再替换视图，替换后在同一事务里抽查视图近 7 天，失败整体回滚。
--
-- Verify: bash scripts/test-db-reorg-p6b1b-display-views.sh
-- Release: TEST -> Production（不需要后端发布）。

DO $views$
DECLARE
  v_display text := md5(pg_get_viewdef('experience.chat_history_display'::regclass));
  v_history text := md5(pg_get_viewdef('experience.session_chat_history'::regclass));
  v_done int := 0;
  v_base_diff bigint;
  v_display_diff bigint;
BEGIN
  -- 两个视图算扣费额用同一个表达式：先在底表全量逐行比对（生产约 4 秒；不看最近 10 分钟仍在进行的轮次），
  -- 不一致就什么都不改
  SELECT count(*) INTO v_base_diff
  FROM experience.chat_history h LEFT JOIN billing.usage_charges uc ON uc.id = h.llm_charge_id
  WHERE h.created_at < now() - interval '10 minutes'
    AND COALESCE(uc.charged_credits, h.deduction_rate) IS DISTINCT FROM h.deduction_rate;
  IF v_base_diff > 0 THEN
    RAISE EXCEPTION 'p6b1b-views: % turns have usage_charges.charged_credits != chat_history.deduction_rate; refusing', v_base_diff;
  END IF;
  SET LOCAL lock_timeout = '5s';
  IF position('usage_charges' IN pg_get_viewdef('experience.chat_history_display'::regclass)) = 0 THEN
    IF v_display <> 'cdb1045f2094b0528e3883740028e0af' THEN
      RAISE EXCEPTION 'p6b1b-views: chat_history_display drifted (md5 %), refusing', v_display;
    END IF;
    CREATE OR REPLACE VIEW experience.chat_history_display WITH (security_invoker = true) AS
    SELECT h.id,
      h.user_id,
      h.model,
      h.user_input,
      h.assistant_reply,
      h.character_id,
      h.status,
      COALESCE(uc.charged_credits, h.deduction_rate)::numeric(14,1) AS deduction_rate,
      h.created_at,
      h.llm_finish_reason,
      h.llm_charge_id,
      h.session_id,
      h.turn_index,
      h.revision,
      h.postprocess_version,
      h.rich_reply_metadata,
      r.first_token_preview,
      m.request_id AS display_request_id,
      m.opening_message AS display_opening_message
    FROM experience.chat_history h
    LEFT JOIN experience.chat_history_display_metadata m ON m.history_id = h.id
    LEFT JOIN experience.chat_generation_requests r ON r.chat_history_id = h.id
    LEFT JOIN billing.usage_charges uc ON uc.id = h.llm_charge_id;
    v_done := v_done + 1;
  END IF;

  IF position('usage_charges' IN pg_get_viewdef('experience.session_chat_history'::regclass)) = 0 THEN
    IF v_history <> '7497e5308f1a9c5263e713be71870c31' THEN
      RAISE EXCEPTION 'p6b1b-views: session_chat_history drifted (md5 %), refusing', v_history;
    END IF;
    CREATE OR REPLACE VIEW experience.session_chat_history WITH (security_invoker = true) AS
    SELECT h.id,
      h.user_id,
      h.model,
      CASE WHEN u.deleted THEN ''::text ELSE COALESCE(u.content, h.user_input) END AS user_input,
      CASE WHEN a.deleted THEN NULL::text ELSE COALESCE(a.content, h.assistant_reply) END AS assistant_reply,
      h.character_id,
      h.status,
      h.deduction_rate,
      h.created_at,
      h.llm_finish_reason,
      h.llm_charge_id,
      h.session_id,
      h.turn_index,
      h.revision,
      h.postprocess_version,
      h.rich_reply_metadata,
      false AS is_inherited,
      (EXISTS (SELECT 1 FROM experience.chat_message_likes l
               WHERE l.session_id = h.session_id AND l.message_id = h.id)) AS liked,
      COALESCE(u.deleted, false) AS user_deleted,
      COALESCE(a.deleted, false) AS assistant_deleted,
      COALESCE(u.version, 0) AS user_edit_version,
      COALESCE(a.version, 0) AS assistant_edit_version
    FROM (
      SELECT DISTINCT ON (c.session_id, c.turn_index) c.id,
        c.user_id,
        c.model,
        c.user_input,
        c.assistant_reply,
        c.character_id,
        c.status,
        COALESCE(uc.charged_credits, c.deduction_rate)::numeric(14,1) AS deduction_rate,
        c.created_at,
        c.llm_finish_reason,
        c.llm_charge_id,
        c.session_id,
        c.turn_index,
        c.revision,
        c.postprocess_version,
        c.rich_reply_metadata
      FROM experience.chat_history c
      LEFT JOIN billing.usage_charges uc ON uc.id = c.llm_charge_id
      WHERE c.session_id IS NOT NULL AND c.turn_index IS NOT NULL AND c.revision IS NOT NULL
      ORDER BY c.session_id, c.turn_index, c.revision DESC
    ) h
    LEFT JOIN experience.chat_message_overrides u ON u.session_id = h.session_id AND u.message_id = h.id AND u.role = 'user'::text
    LEFT JOIN experience.chat_message_overrides a ON a.session_id = h.session_id AND a.message_id = h.id AND a.role = 'assistant'::text
    UNION ALL
    SELECT h.id,
      s.user_id,
      h.model,
      CASE WHEN u.deleted THEN ''::text ELSE COALESCE(u.content, h.user_input) END AS user_input,
      CASE WHEN a.deleted THEN NULL::text ELSE COALESCE(a.content, h.assistant_reply) END AS assistant_reply,
      s.character_id,
      h.status,
      NULL::numeric AS deduction_rate,
      h.created_at,
      h.llm_finish_reason,
      NULL::uuid AS llm_charge_id,
      inherited.session_id,
      inherited.turn_index,
      h.revision,
      h.postprocess_version,
      h.rich_reply_metadata,
      true AS is_inherited,
      (EXISTS (SELECT 1 FROM experience.chat_message_likes l
               WHERE l.session_id = inherited.session_id AND l.message_id = h.id)) AS liked,
      COALESCE(u.deleted, false) AS user_deleted,
      COALESCE(a.deleted, false) AS assistant_deleted,
      COALESCE(u.version, 0) AS user_edit_version,
      COALESCE(a.version, 0) AS assistant_edit_version
    FROM experience.chat_branch_turns inherited
    JOIN experience.chat_sessions s ON s.id = inherited.session_id
    JOIN experience.chat_history h ON h.id = inherited.source_history_id AND h.user_id = s.user_id AND h.character_id = s.character_id
    LEFT JOIN experience.chat_message_overrides u ON u.session_id = inherited.session_id AND u.message_id = h.id AND u.role = 'user'::text
    LEFT JOIN experience.chat_message_overrides a ON a.session_id = inherited.session_id AND a.message_id = h.id AND a.role = 'assistant'::text
    WHERE NOT (EXISTS (SELECT 1 FROM experience.chat_history own
                       WHERE own.session_id = inherited.session_id AND own.turn_index = inherited.turn_index));
    v_done := v_done + 1;
  END IF;
  -- 同一事务里抽查视图本身近 7 天（时间条件能下推到 chat_history_display），失败整体回滚
  SELECT count(*) INTO v_display_diff
  FROM experience.chat_history_display d JOIN experience.chat_history h ON h.id = d.id
  WHERE d.created_at > now() - interval '7 days' AND h.created_at < now() - interval '10 minutes'
    AND d.deduction_rate IS DISTINCT FROM h.deduction_rate;
  IF v_display_diff > 0 THEN
    RAISE EXCEPTION 'p6b1b-views: % recent rows of chat_history_display differ after the switch', v_display_diff;
  END IF;
  RAISE NOTICE 'p6b1b-views: % display views now read the charge from usage_charges; rows match chat_history', v_done;
END
$views$;

