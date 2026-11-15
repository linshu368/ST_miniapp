-- domain: miniapp_analytics（一次性问卷答卷，只用于分析，产品运行时不读）
--       + billing（问卷奖励的星尘流水与发放函数）。
-- 短剧原因问卷 drama_reason_v1：只给本机有过有效观看的用户，在任意对话聊满 4 轮后弹出；
-- 判断体验过短剧的用户不继续看的主因是耗时还是内容。提交后发放 bonus 星尘，每个账号只发一次。
-- 前置：app_core.users、app_core.runtime_config、billing.user_wallets、billing.wallet_ledger。
--
-- "每个账号只领一次"由答卷表主键 (survey_key, user_id) 在发奖的同一事务里保证：
-- 不在 wallet_ledger 上新建唯一索引，避免在资金大表上建索引时阻塞聊天扣费写入。
-- 流水类型约束只追加 survey_reward，用 NOT VALID，不扫历史行。
--
-- 发布：TEST 单文件 → Backend/Frontend（开关默认关，线上无变化）→ Production 单文件
--       → UPDATE app_core.runtime_config SET value='true'::jsonb WHERE key='miniapp_drama_survey_enabled'。
-- 收尾（问卷结束并导出结果后）：先关开关，再
--   DROP FUNCTION billing.submit_drama_survey(uuid,text,integer,text[],text,text[],text,text,text,integer,integer);
--   DROP TABLE miniapp_analytics.drama_survey_responses;
--   流水中 entry_type='survey_reward' 的记录属于资金审计事实，保留；runtime_config 行可以删除。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF to_regclass('app_core.users') IS NULL
    OR to_regclass('app_core.runtime_config') IS NULL
    OR to_regclass('billing.user_wallets') IS NULL
    OR to_regclass('billing.wallet_ledger') IS NULL THEN
    RAISE EXCEPTION 'drama survey requires app_core users/runtime_config and billing wallet tables';
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS miniapp_analytics;

CREATE TABLE IF NOT EXISTS miniapp_analytics.drama_survey_responses (
  survey_key text NOT NULL
    CONSTRAINT drama_survey_responses_key_check CHECK (survey_key ~ '^[a-z0-9_]{1,40}$'),
  user_id uuid NOT NULL
    CONSTRAINT drama_survey_responses_user_fkey REFERENCES app_core.users(id) ON DELETE CASCADE,
  status text NOT NULL
    CONSTRAINT drama_survey_responses_status_check CHECK (status IN ('submitted', 'dismissed')),
  open_reasons text[] NOT NULL DEFAULT '{}'
    CONSTRAINT drama_survey_responses_open_reasons_check
    CHECK (cardinality(open_reasons) <= 2 AND array_position(open_reasons, NULL) IS NULL),
  open_other_text text
    CONSTRAINT drama_survey_responses_open_other_check CHECK (char_length(open_other_text) <= 200),
  watch_reasons text[] NOT NULL DEFAULT '{}'
    CONSTRAINT drama_survey_responses_watch_reasons_check
    CHECK (cardinality(watch_reasons) <= 2 AND array_position(watch_reasons, NULL) IS NULL),
  watch_other_text text
    CONSTRAINT drama_survey_responses_watch_other_check CHECK (char_length(watch_other_text) <= 200),
  comment text
    CONSTRAINT drama_survey_responses_comment_check CHECK (char_length(comment) <= 500),
  platform text
    CONSTRAINT drama_survey_responses_platform_check CHECK (char_length(platform) <= 32),
  engaged_dramas integer
    CONSTRAINT drama_survey_responses_engaged_check CHECK (engaged_dramas BETWEEN 1 AND 200),
  max_episode integer
    CONSTRAINT drama_survey_responses_episode_check CHECK (max_episode BETWEEN 1 AND 100000),
  reward_credits integer
    CONSTRAINT drama_survey_responses_reward_check CHECK (reward_credits > 0),
  wallet_ledger_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  CONSTRAINT drama_survey_responses_pkey PRIMARY KEY (survey_key, user_id),
  CONSTRAINT drama_survey_responses_submitted_check CHECK (
    status <> 'submitted' OR (
      cardinality(open_reasons) >= 1 AND cardinality(watch_reasons) >= 1
      AND engaged_dramas IS NOT NULL AND max_episode IS NOT NULL
      AND submitted_at IS NOT NULL AND reward_credits IS NOT NULL
    )
  )
);
COMMENT ON TABLE miniapp_analytics.drama_survey_responses IS
  '一次性问卷答卷（每个账号每份问卷一行）。status=dismissed 表示叉掉；提交会覆盖叉掉记录，已提交的不再改写。只用于分析，问卷结束导出后整表删除。';
COMMENT ON COLUMN miniapp_analytics.drama_survey_responses.open_reasons IS
  'Q2a 选项编码（不是展示文案），取值见 packages/shared/src/api/drama-survey.ts；watch_reasons 为 Q2b。';
COMMENT ON COLUMN miniapp_analytics.drama_survey_responses.engaged_dramas IS
  '前端本机追剧记录中有过有效观看的剧数（客户端上报，未经服务端核验）；max_episode 为其中看到的最大集数。';

ALTER TABLE miniapp_analytics.drama_survey_responses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp_analytics.drama_survey_responses FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA miniapp_analytics TO service_role;
-- 后端只追加叉掉记录（ON CONFLICT DO NOTHING）和读报表；提交只走下面的发放函数。
GRANT SELECT, INSERT ON miniapp_analytics.drama_survey_responses TO service_role;

-- 只在旧规则后追加 survey_reward，不复制（也就不会误删）其他团队的流水类型。
DO $$ DECLARE old_rule text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO old_rule FROM pg_constraint
    WHERE conrelid = 'billing.wallet_ledger'::regclass
      AND conname = 'wallet_ledger_entry_type_check';
  IF old_rule IS NULL THEN RAISE EXCEPTION 'Expected ledger entry type check is missing'; END IF;
  IF position('survey_reward' IN old_rule) = 0 THEN
    ALTER TABLE billing.wallet_ledger DROP CONSTRAINT wallet_ledger_entry_type_check;
    EXECUTE format(
      'ALTER TABLE billing.wallet_ledger ADD CONSTRAINT wallet_ledger_entry_type_check CHECK ((%s) OR entry_type = ''survey_reward'') NOT VALID',
      old_rule
    );
  END IF;
END $$;

-- 写答卷、加 bonus 星尘、记流水在同一事务里完成：要么全部成功，要么全部不生效。
-- 并发的两次提交会在主键上排队，后到的一次看到 status=submitted，返回 already_rewarded。
CREATE OR REPLACE FUNCTION billing.submit_drama_survey(
  p_user_id uuid,
  p_survey_key text,
  p_reward_credits integer,
  p_open_reasons text[],
  p_open_other_text text,
  p_watch_reasons text[],
  p_watch_other_text text,
  p_comment text,
  p_platform text,
  p_engaged_dramas integer,
  p_max_episode integer
) RETURNS TABLE (result_status text, result_credits integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_claimed boolean;
  v_wallet billing.user_wallets%ROWTYPE;
  v_ledger_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_reward_credits IS NULL OR p_reward_credits <= 0 OR p_reward_credits > 1000 THEN
    RAISE EXCEPTION 'invalid drama survey input' USING ERRCODE = '22023';
  END IF;

  INSERT INTO miniapp_analytics.drama_survey_responses AS r
    (survey_key, user_id, status, open_reasons, open_other_text, watch_reasons, watch_other_text,
     comment, platform, engaged_dramas, max_episode, reward_credits, submitted_at)
  VALUES (
    p_survey_key, p_user_id, 'submitted',
    COALESCE(p_open_reasons, '{}'), NULLIF(btrim(p_open_other_text), ''),
    COALESCE(p_watch_reasons, '{}'), NULLIF(btrim(p_watch_other_text), ''),
    NULLIF(btrim(p_comment), ''), NULLIF(btrim(p_platform), ''),
    p_engaged_dramas, p_max_episode, p_reward_credits, now()
  )
  ON CONFLICT ON CONSTRAINT drama_survey_responses_pkey DO UPDATE SET
    status = 'submitted',
    open_reasons = EXCLUDED.open_reasons,
    open_other_text = EXCLUDED.open_other_text,
    watch_reasons = EXCLUDED.watch_reasons,
    watch_other_text = EXCLUDED.watch_other_text,
    comment = EXCLUDED.comment,
    platform = EXCLUDED.platform,
    engaged_dramas = EXCLUDED.engaged_dramas,
    max_episode = EXCLUDED.max_episode,
    reward_credits = EXCLUDED.reward_credits,
    submitted_at = EXCLUDED.submitted_at
  WHERE r.status = 'dismissed'
  RETURNING true INTO v_claimed;

  IF v_claimed IS NULL THEN
    RETURN QUERY
      SELECT 'already_rewarded'::text, r.reward_credits
      FROM miniapp_analytics.drama_survey_responses r
      WHERE r.survey_key = p_survey_key AND r.user_id = p_user_id;
    RETURN;
  END IF;

  INSERT INTO billing.user_wallets (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
  UPDATE billing.user_wallets w
    SET bonus_credits = w.bonus_credits + p_reward_credits, updated_at = now()
    WHERE w.user_id = p_user_id
    RETURNING w.* INTO v_wallet;

  INSERT INTO billing.wallet_ledger
    (user_id, entry_type, amount, main_delta, bonus_delta, balance_main, balance_bonus,
     reference_type, reference_id, metadata)
  VALUES (p_user_id, 'survey_reward', p_reward_credits, 0, p_reward_credits,
    v_wallet.main_credits, v_wallet.bonus_credits, 'survey', p_survey_key,
    jsonb_build_object('survey_key', p_survey_key))
  RETURNING id INTO v_ledger_id;

  UPDATE miniapp_analytics.drama_survey_responses r
    SET wallet_ledger_id = v_ledger_id
    WHERE r.survey_key = p_survey_key AND r.user_id = p_user_id;

  RETURN QUERY SELECT 'rewarded'::text, p_reward_credits;
END $$;
COMMENT ON FUNCTION billing.submit_drama_survey(uuid,text,integer,text[],text,text[],text,text,text,integer,integer) IS
  '一次性问卷提交并发放 bonus 星尘（流水 entry_type=survey_reward, reference_type=survey, reference_id=survey_key）。问卷结束后删除。';

REVOKE ALL ON FUNCTION billing.submit_drama_survey(uuid,text,integer,text[],text,text[],text,text,text,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.submit_drama_survey(uuid,text,integer,text[],text,text[],text,text,text,integer,integer) TO service_role;

INSERT INTO app_core.runtime_config (key, value, description, version, updated_at, text_value) VALUES
  ('miniapp_drama_survey_enabled', 'false'::jsonb, '短剧原因问卷弹窗与发奖总开关（一次性问卷，结束后可删）', 1, now(), NULL)
ON CONFLICT (key) DO NOTHING;

COMMIT;
