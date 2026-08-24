-- 092: 免费额度耗尽提示从弹窗标题+说明改为单行轻提示文案。
--
-- 库侧校验与 runtime_config 存值从 { title, description } 改为 { text }。
-- 运营台发布仍走 admin.validate_free_quota_exhausted_dialog_config，只替换该函数即可。

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
     OR COALESCE(char_length(trim(p_value ->> 'text')), 0) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'miniapp_free_quota_exhausted_dialog_config is invalid'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

COMMENT ON FUNCTION admin.validate_free_quota_exhausted_dialog_config(JSONB) IS
  'Validate the single-line copy for the free-quota exhausted notice.';

UPDATE miniapp.runtime_config
SET
  value = jsonb_build_object(
    'text',
    '和「{characterName}」的免费轮次用完了。这是这张卡的免费额度，其他角色不受影响。往后每轮消耗星尘。'
  ),
  description = '角色卡免费额度耗尽后，在该轮回复下方展示的轻提示文案；使用 {characterName} 插入当前角色名。',
  version = version + 1,
  updated_at = now()
WHERE key = 'miniapp_free_quota_exhausted_dialog_config'
  AND NOT (value ? 'text');

COMMIT;
