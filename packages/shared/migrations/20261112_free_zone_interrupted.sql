-- 畅聊：每轮事实视图补「主模型交付」「生成中断」两列，评估任务与 Grafana 用同一口径看中断率。
--
-- 生成中断 = 这一轮由免费模型自己交付（不是兜底），开始出字后没写完就断了：
--   business_status = 'stream_interrupted'，且不是用户自己点停（user_cancelled），
--   也不是内容审核（content_filter，已算在 refused 里）。上游报错、超时、连接断开都算。
-- 中断率的分母是主模型交付的轮次（primary_delivered）：只问「开始出字的里面，断了多少」。
--
-- 只在视图末尾追加列（CREATE OR REPLACE VIEW 允许），已有列与权限不变；重复执行无副作用。
-- 回滚：用 20261112_free_zone.sql 里的原定义重建视图会去掉这两列——Postgres 不允许
--   CREATE OR REPLACE 删列，需要先 DROP VIEW 再建、并重新授权；后端读不到新列时评估会报错，
--   所以回滚前先回退后端。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE VIEW miniapp_analytics.free_zone_turn_facts AS
SELECT
  f.chat_history_id,
  f.request_received_at AS turn_at,
  f.requested_model_id AS model_id,
  s.provider_name AS served_provider,
  f.primary_actual_first_token_ms IS NOT NULL AS primary_output,
  f.delivery_role = 'fallback' AS fallback_delivered,
  COALESCE(f.server_first_token_timeout, false) AS timed_out,
  f.primary_actual_first_token_ms AS primary_ttft_ms,
  f.business_finish_reason = 'content_filter' AS refused,
  f.business_finish_reason = 'length' AS truncated,
  s.buyer_cost_micro / 1000000.0 AS buyer_cost_usd,
  s.prompt_tokens,
  s.cached_tokens,
  COALESCE(f.delivery_role = 'primary', false) AS primary_delivered,
  COALESCE(
    f.delivery_role = 'primary'
      AND f.business_status = 'stream_interrupted'
      AND COALESCE(f.business_finish_reason, '') NOT IN ('user_cancelled', 'content_filter'),
    false
  ) AS interrupted
FROM miniapp_analytics.chat_first_token_facts f
LEFT JOIN experience.surplusintelligence_chat_history s ON s.chat_history_id = f.chat_history_id
WHERE f.requested_model_id LIKE 'free-%';

COMMENT ON COLUMN miniapp_analytics.free_zone_turn_facts.primary_delivered IS
  '这一轮由免费模型自己交付（不是兜底）；中断率的分母。';
COMMENT ON COLUMN miniapp_analytics.free_zone_turn_facts.interrupted IS
  '免费模型开始出字后没写完就断了（上游报错、超时、断连）；不含用户点停与内容审核。';

COMMIT;
