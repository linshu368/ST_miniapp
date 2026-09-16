-- 20260916: 图片描述调用前审计与 draft attempt 状态。
-- domain: experience + app_core
-- 前置：20260914_chat_message_images.sql 已执行。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE experience.chat_message_images
  ADD COLUMN IF NOT EXISTS description_user_prompt TEXT;

ALTER TABLE experience.chat_message_images
  ALTER COLUMN prompt_cn DROP NOT NULL,
  ALTER COLUMN prompt_source DROP NOT NULL;

ALTER TABLE experience.chat_message_images
  DROP CONSTRAINT IF EXISTS chat_message_images_status_check;
ALTER TABLE experience.chat_message_images
  ADD CONSTRAINT chat_message_images_status_check CHECK (status IN (
    'draft_describing', 'draft_ready', 'draft_failed',
    'pending', 'leased', 'generating', 'storing', 'ready', 'failed', 'failed_unknown'
  ));

ALTER TABLE experience.chat_message_images
  DROP CONSTRAINT IF EXISTS chat_message_images_prompt_state_check;
ALTER TABLE experience.chat_message_images
  ADD CONSTRAINT chat_message_images_prompt_state_check CHECK (
    (status = 'draft_describing' AND description_user_prompt IS NOT NULL)
    OR (status = 'draft_failed' AND description_user_prompt IS NOT NULL)
    OR (status = 'draft_ready'
        AND description_user_prompt IS NOT NULL
        AND prompt_cn IS NOT NULL
        AND prompt_source = 'generated')
    OR (status IN ('pending', 'leased', 'generating', 'storing', 'ready', 'failed', 'failed_unknown')
        AND prompt_cn IS NOT NULL
        AND prompt_source IS NOT NULL)
  );

COMMENT ON COLUMN experience.chat_message_images.description_user_prompt IS
  '图片描述模型调用前保存的完整 user prompt；含角色与对话敏感正文，仅 backend service role 可读。';

INSERT INTO app_core.runtime_config(key, value, description, version, updated_at, text_value)
VALUES (
  'image_text_model_config',
  '{"url":"","api_key":"","model":""}'::JSONB,
  '图片描述与翻译使用的 OpenAI-compatible 文本模型配置；空字段时回退当前 DeepSeek 参数。仅 backend service role 可读。',
  1,
  now(),
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- image_text_model_config 不写入真实密钥，空配置时 backend 默认使用当前 DeepSeek 配置。
-- 运维按单行 JSON 原子配置：{"url":"https://...","api_key":"...","model":"..."}。
-- 该 key 不纳入 Admin managed config，避免 API key 进入草稿、发布和审计快照。

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'experience'
      AND table_name = 'chat_message_images'
      AND column_name = 'description_user_prompt'
  ) THEN
    RAISE EXCEPTION 'self-check failed: description_user_prompt missing';
  END IF;
END;
$$;

COMMIT;
NOTIFY pgrst, 'reload schema';