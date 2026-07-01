-- 024: CS Platform - SQL user segmentation and Telegram 1v1 SOP outreach.
--
-- 目标：
--   - 为内部客服回访工作台建立独立 schema
--   - 画像簇保存受控只读 SQL，并可实时刷新成员
--   - 回访对话通过 Telegram Bot 收发，但记录只落在 cs_platform 自有表
--   - 导出和审计具备可追溯的用户背景与原始对话

CREATE SCHEMA IF NOT EXISTS cs_platform;

CREATE TABLE IF NOT EXISTS cs_platform.personas (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  color              TEXT NOT NULL DEFAULT '#5BBD72',
  sql_text           TEXT NOT NULL,
  opening_script     TEXT NOT NULL DEFAULT '',
  sop                JSONB NOT NULL DEFAULT '[]'::jsonb,
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'archived')),
  active_count        INTEGER NOT NULL DEFAULT 0 CHECK (active_count >= 0),
  chatted_left_count  INTEGER NOT NULL DEFAULT 0 CHECK (chatted_left_count >= 0),
  last_refreshed_at   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cs_platform.persona_refresh_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id          UUID NOT NULL REFERENCES cs_platform.personas(id) ON DELETE CASCADE,
  operator_id         TEXT NOT NULL DEFAULT 'system',
  sql_text            TEXT NOT NULL,
  active_count        INTEGER NOT NULL DEFAULT 0,
  entered_count       INTEGER NOT NULL DEFAULT 0,
  chatted_left_count  INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'succeeded', 'failed')),
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS cs_platform.persona_member_snapshots (
  run_id       UUID NOT NULL REFERENCES cs_platform.persona_refresh_runs(id) ON DELETE CASCADE,
  persona_id   UUID NOT NULL REFERENCES cs_platform.personas(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, user_id)
);

CREATE TABLE IF NOT EXISTS cs_platform.persona_member_state (
  persona_id         UUID NOT NULL REFERENCES cs_platform.personas(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  membership_status  TEXT NOT NULL DEFAULT 'active'
                     CHECK (membership_status IN ('active', 'chatted_left')),
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_run_id    UUID REFERENCES cs_platform.persona_refresh_runs(id) ON DELETE SET NULL,
  first_contacted_at  TIMESTAMPTZ,
  last_contacted_at   TIMESTAMPTZ,
  left_at             TIMESTAMPTZ,
  left_note           TEXT,
  PRIMARY KEY (persona_id, user_id)
);

CREATE TABLE IF NOT EXISTS cs_platform.outreach_sessions (
  persona_id            UUID NOT NULL REFERENCES cs_platform.personas(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'not_started'
                        CHECK (status IN (
                          'not_started',
                          'icebreaking',
                          'waiting_reply',
                          'following_up',
                          'completed',
                          'snoozed',
                          'skipped',
                          'send_failed'
                        )),
  current_stage         TEXT,
  current_question_key  TEXT,
  next_touch_at         TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  skipped_at            TIMESTAMPTZ,
  skip_reason           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (persona_id, user_id)
);

CREATE TABLE IF NOT EXISTS cs_platform.outreach_messages (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id           UUID NOT NULL REFERENCES cs_platform.personas(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  telegram_user_id     TEXT NOT NULL,
  direction            TEXT NOT NULL CHECK (direction IN ('agent', 'user')),
  sop_stage            TEXT,
  question_key         TEXT,
  content              TEXT NOT NULL CHECK (char_length(trim(content)) > 0),
  send_status          TEXT NOT NULL DEFAULT 'pending'
                       CHECK (send_status IN ('pending', 'sent', 'failed', 'received')),
  idempotency_key      TEXT,
  telegram_message_id  TEXT,
  sent_at              TIMESTAMPTZ,
  received_at          TIMESTAMPTZ,
  failed_reason        TEXT,
  operator_id          TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cs_outreach_messages_idempotency
  ON cs_platform.outreach_messages(persona_id, user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cs_outreach_messages_user_created
  ON cs_platform.outreach_messages(persona_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cs_platform.export_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id     UUID REFERENCES cs_platform.personas(id) ON DELETE SET NULL,
  operator_id    TEXT NOT NULL,
  row_count      INTEGER NOT NULL DEFAULT 0,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cs_platform.audit_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id    TEXT NOT NULL,
  action         TEXT NOT NULL,
  persona_id     UUID REFERENCES cs_platform.personas(id) ON DELETE SET NULL,
  user_id        UUID REFERENCES public.users(id) ON DELETE SET NULL,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
    COALESCE(NULLIF(user_id, '')::UUID, NULL) AS user_id,
    max(COALESCE(accept_at, created_at)) AS last_message_at
  FROM public.messages
  WHERE user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  GROUP BY COALESCE(NULLIF(user_id, '')::UUID, NULL)
)
SELECT
  u.id AS user_id,
  u.tg_id AS telegram_user_id,
  COALESCE(NULLIF(s.display_name, ''), NULLIF(s.tg_username, ''), NULLIF(s.tg_first_name, ''), u.tg_id) AS display_name,
  s.tg_username AS username,
  GREATEST(floor(extract(epoch FROM (now() - u.created_at)) / 86400)::INTEGER, 0) AS register_days,
  COALESCE(w.total_paid_amount, u.total_paid_amount, 0)::NUMERIC(12, 2) AS total_paid_amount,
  COALESCE(p.paid_count, 0)::INTEGER AS paid_count,
  COALESCE(s.total_round, 0)::BIGINT AS total_round,
  COALESCE(m.last_message_at, s.updated_at, u.updated_at, u.created_at) AS last_active_at
FROM public.users u
LEFT JOIN miniapp.miniapp_user_settings s ON s.user_id = u.id
LEFT JOIN miniapp.user_wallets w ON w.user_id = u.id
LEFT JOIN payment_summary p ON p.user_id = u.id
LEFT JOIN message_activity m ON m.user_id = u.id;

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
  ms.left_note
FROM cs_platform.persona_member_state ms
JOIN cs_platform.user_metrics um ON um.user_id = ms.user_id
LEFT JOIN cs_platform.outreach_sessions os
  ON os.persona_id = ms.persona_id AND os.user_id = ms.user_id;

CREATE OR REPLACE FUNCTION cs_platform.validate_persona_sql(p_sql TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_sql TEXT := trim(p_sql);
  v_plan JSONB;
  v_has_modify_node BOOLEAN := false;
BEGIN
  IF v_sql = '' THEN
    RAISE EXCEPTION 'persona sql must not be empty'
      USING ERRCODE = '22023';
  END IF;

  IF v_sql LIKE '%;%' THEN
    RAISE EXCEPTION 'persona sql must contain exactly one statement'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    EXECUTE format('EXPLAIN (FORMAT JSON) %s', v_sql) INTO v_plan;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'persona sql validation failed: %', SQLERRM
      USING ERRCODE = '22023';
  END;

  SELECT EXISTS (
    SELECT 1
    FROM jsonb_path_query(v_plan, '$.**') AS node(value)
    WHERE value @> '{"Node Type":"ModifyTable"}'::jsonb
       OR value->>'Operation' IN ('Insert', 'Update', 'Delete', 'Merge')
  )
  INTO v_has_modify_node;

  IF v_has_modify_node THEN
    RAISE EXCEPTION 'persona sql must be read-only SELECT'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION cs_platform.refresh_persona_members(
  p_persona_id UUID,
  p_operator_id TEXT DEFAULT 'system'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_persona cs_platform.personas;
  v_run_id UUID;
  v_refreshed_at TIMESTAMPTZ := now();
  v_active_count INTEGER := 0;
  v_entered_count INTEGER := 0;
  v_chatted_left_count INTEGER := 0;
BEGIN
  SELECT *
  INTO v_persona
  FROM cs_platform.personas
  WHERE id = p_persona_id
    AND status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'persona not found or archived: %', p_persona_id
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM cs_platform.validate_persona_sql(v_persona.sql_text);

  INSERT INTO cs_platform.persona_refresh_runs (persona_id, operator_id, sql_text)
  VALUES (p_persona_id, COALESCE(NULLIF(p_operator_id, ''), 'system'), v_persona.sql_text)
  RETURNING id INTO v_run_id;

  EXECUTE format(
    'INSERT INTO cs_platform.persona_member_snapshots (run_id, persona_id, user_id)
     SELECT %L::uuid, %L::uuid, q.user_id::uuid
     FROM (%s) AS q
     WHERE q.user_id IS NOT NULL
     ON CONFLICT (run_id, user_id) DO NOTHING',
    v_run_id,
    p_persona_id,
    v_persona.sql_text
  );

  INSERT INTO cs_platform.persona_member_state (
    persona_id,
    user_id,
    membership_status,
    first_seen_at,
    last_seen_at,
    last_seen_run_id
  )
  SELECT
    p_persona_id,
    user_id,
    'active',
    v_refreshed_at,
    v_refreshed_at,
    v_run_id
  FROM cs_platform.persona_member_snapshots
  WHERE run_id = v_run_id
  ON CONFLICT (persona_id, user_id) DO UPDATE
  SET
    membership_status = 'active',
    last_seen_at = EXCLUDED.last_seen_at,
    last_seen_run_id = EXCLUDED.last_seen_run_id,
    left_at = NULL,
    left_note = NULL;

  GET DIAGNOSTICS v_entered_count = ROW_COUNT;

  UPDATE cs_platform.persona_member_state state
  SET
    membership_status = 'chatted_left',
    left_at = COALESCE(state.left_at, v_refreshed_at),
    left_note = '用户已不再命中当前画像簇 SQL，但保留本簇回访记录。'
  WHERE state.persona_id = p_persona_id
    AND state.first_contacted_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM cs_platform.persona_member_snapshots snap
      WHERE snap.run_id = v_run_id
        AND snap.user_id = state.user_id
    );

  SELECT count(*)::INTEGER
  INTO v_active_count
  FROM cs_platform.persona_member_state
  WHERE persona_id = p_persona_id
    AND membership_status = 'active';

  SELECT count(*)::INTEGER
  INTO v_chatted_left_count
  FROM cs_platform.persona_member_state
  WHERE persona_id = p_persona_id
    AND membership_status = 'chatted_left';

  UPDATE cs_platform.persona_refresh_runs
  SET
    status = 'succeeded',
    active_count = v_active_count,
    entered_count = v_entered_count,
    chatted_left_count = v_chatted_left_count,
    completed_at = v_refreshed_at
  WHERE id = v_run_id;

  UPDATE cs_platform.personas
  SET
    active_count = v_active_count,
    chatted_left_count = v_chatted_left_count,
    last_refreshed_at = v_refreshed_at,
    updated_at = v_refreshed_at
  WHERE id = p_persona_id;

  INSERT INTO cs_platform.audit_logs (operator_id, action, persona_id, metadata)
  VALUES (
    COALESCE(NULLIF(p_operator_id, ''), 'system'),
    'persona.refresh',
    p_persona_id,
    jsonb_build_object(
      'run_id', v_run_id,
      'active_count', v_active_count,
      'entered_count', v_entered_count,
      'chatted_left_count', v_chatted_left_count
    )
  );

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'active_count', v_active_count,
    'entered_count', v_entered_count,
    'chatted_left_count', v_chatted_left_count,
    'refreshed_at', v_refreshed_at
  );
EXCEPTION WHEN OTHERS THEN
  IF v_run_id IS NOT NULL THEN
    UPDATE cs_platform.persona_refresh_runs
    SET status = 'failed', error_message = SQLERRM, completed_at = now()
    WHERE id = v_run_id;
  END IF;
  RAISE;
END;
$$;

ALTER TABLE cs_platform.personas ENABLE ROW LEVEL SECURITY;
ALTER TABLE cs_platform.persona_refresh_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cs_platform.persona_member_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE cs_platform.persona_member_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE cs_platform.outreach_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cs_platform.outreach_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE cs_platform.export_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cs_platform.audit_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON SCHEMA cs_platform FROM anon, authenticated;
GRANT USAGE ON SCHEMA cs_platform TO service_role, postgres;
GRANT ALL ON ALL TABLES IN SCHEMA cs_platform TO service_role, postgres;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA cs_platform TO service_role, postgres;

INSERT INTO cs_platform.personas (
  slug,
  name,
  description,
  color,
  sql_text,
  opening_script,
  sop
) VALUES
(
  'power_user',
  '深度用户',
  '对话轮次大于 40 且使用产品超过 7 天',
  '#5BBD72',
  'SELECT u.id AS user_id
FROM public.users u
JOIN miniapp.miniapp_user_settings s ON s.user_id = u.id
WHERE s.total_round > 40
  AND u.created_at < now() - interval ''7 days''
ORDER BY s.total_round DESC',
  'Hi~ 我是XX的运营客服，想花几分钟听听你的使用感受，方便吗？',
  '[
    {"key":"icebreaker","title":"破冰","prompt":"Hi~ 我是XX的运营客服，想花几分钟听听你的使用感受，方便吗？"},
    {"key":"pain","title":"体验痛点","prompt":"您平时跟角色聊天的时候，有没有遇到什么让您特别不爽的地方？卡顿、bug、或者觉得哪里别扭的，都算。","followups":["这种情况大概多久出现一次？","当时是在什么场景下？"]},
    {"key":"feature","title":"最想要的功能","prompt":"如果我们接下来只能加一个新功能，您最希望是什么？","followups":["这个功能对您来说主要是解决什么问题？"],"fallback_options":["① 语音消息（让角色用语音念出来）","② 状态栏（看到角色心情/好感度）","③ 超强记忆（聊几百回合不失忆）","④ 生成图片（根据场景生成角色图）","⑤ 自建角色卡（自己创建和保存角色）"]},
    {"key":"role_preference","title":"角色卡偏好","prompt":"您有没有特别想聊但我们大厅里没有的角色类型？什么设定都行"},
    {"key":"closing","title":"收尾","prompt":"感谢你的真实反馈，这对我们很重要。以后有任何不爽的地方，随时找我，我帮您催开发！祝您玩得开心~"}
  ]'::jsonb
),
(
  'churned_active',
  '活跃后流失',
  '连续活跃≥7天后断了≥3天',
  '#E85D4A',
  'SELECT u.id AS user_id
FROM public.users u
JOIN miniapp.miniapp_user_settings s ON s.user_id = u.id
WHERE s.total_round > 40
  AND u.created_at < now() - interval ''7 days''
  AND COALESCE(s.updated_at, u.updated_at, u.created_at) < now() - interval ''3 days''
ORDER BY COALESCE(s.updated_at, u.updated_at, u.created_at) DESC',
  'Hi~ 好几天没看到你，最近还好吗？是不是我们哪里没做好？',
  '[]'::jsonb
),
(
  'first_pay',
  '首次付费',
  '首次付费后24小时内',
  '#E8A84A',
  'SELECT DISTINCT u.id AS user_id
FROM public.users u
JOIN miniapp.user_wallets w ON w.user_id = u.id
WHERE w.first_paid_at > now() - interval ''24 hours''
ORDER BY w.first_paid_at DESC',
  '感谢支持！冒昧问一句，当时是什么让你决定充值的？',
  '[]'::jsonb
),
(
  'new_drop',
  '新用户流失',
  '聊1-2轮后3-7天未回',
  '#4A90D9',
  'SELECT u.id AS user_id
FROM public.users u
JOIN miniapp.miniapp_user_settings s ON s.user_id = u.id
WHERE s.total_round BETWEEN 1 AND 2
  AND u.created_at BETWEEN now() - interval ''7 days'' AND now() - interval ''3 days''
  AND COALESCE(s.updated_at, u.updated_at, u.created_at) < now() - interval ''3 days''
ORDER BY u.created_at DESC',
  'Hi~ 看到你之前试了一下我们的角色，是不是哪里不太对？还是没找到感兴趣的角色？',
  '[]'::jsonb
)
ON CONFLICT (slug) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  color = EXCLUDED.color,
  sql_text = EXCLUDED.sql_text,
  opening_script = EXCLUDED.opening_script,
  sop = CASE
    WHEN cs_platform.personas.sop = '[]'::jsonb THEN EXCLUDED.sop
    ELSE cs_platform.personas.sop
  END,
  updated_at = now();

COMMENT ON SCHEMA cs_platform IS
  '内部 CS Platform：基于 SQL 用户分层的 Telegram 1V1 回访 SOP 工作台。';
