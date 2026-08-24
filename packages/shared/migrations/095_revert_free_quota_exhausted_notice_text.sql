-- 095: 回退 092。dev 已执行过 092（校验函数与 runtime_config 变成 { text }），
-- PR #270 代码已 revert 回 { title, description }，库侧必须同步还原。
-- 未执行过 092 的环境：CREATE OR REPLACE 幂等；UPDATE 只改仍带 text 且没有 title 的行。

BEGIN;

CREATE OR REPLACE FUNCTION admin.validate_free_quota_exhausted_dialog_config(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_value IS NULL
     OR jsonb_typeof(p_value) IS DISTINCT FROM 'object'
     OR COALESCE(char_length(trim(p_value ->> 'title')), 0) NOT BETWEEN 1 AND 40
     OR COALESCE(char_length(trim(p_value ->> 'description')), 0) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'miniapp_free_quota_exhausted_dialog_config is invalid'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

COMMENT ON FUNCTION admin.validate_free_quota_exhausted_dialog_config(JSONB) IS
  'Validate title and description copy for the free-quota exhausted dialog.';

UPDATE miniapp.runtime_config
SET
  value = '{
    "title": "▎ 和「{characterName}」的 40 轮免费时光结束了",
    "description": "▎\n▎ 这是这张卡的免费额度，其他角色都不受影响。\n▎ 往后每轮消耗星尘，故事还在继续。"
  }'::JSONB,
  description = '角色卡免费额度耗尽后自动展示的标题和说明文案；{characterName} 会替换为当前角色名。轮次数请与 miniapp_character_free_chat_quota_limit 保持一致。',
  version = version + 1,
  updated_at = now()
WHERE key = 'miniapp_free_quota_exhausted_dialog_config'
  AND (value ? 'text')
  AND NOT (value ? 'title');

COMMIT;
