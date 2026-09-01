-- 107: 裂变邀请海报对象存储桶。
-- domain: acquisition（配套 105/106 的裂变邀请功能，见 docs/裂变阶段二实施计划.md）
--
-- 背景：真机验收反馈「邀请海报要求贴图片 URL 对运营不方便」，改为运营台直接上传
-- PNG / JPG / WEBP 常规图片（backend POST /api/admin/invite-poster，service_role 写入），
-- 上传成功后把 public URL 写进 miniapp_invite_center_config.poster_url，仍走草稿/发布。
--
-- 公开桶：海报地址直接进 C 端 <img src>，且经 config 发布/回滚引用历史 URL，
-- 签名 URL 会过期，故与 miniapp-user-avatars（030）、miniapp-chat-voice（080）同为 public。
-- 上传路径带时间戳与随机段（posters/<ts>-<rand>.<ext>），每次上传落新对象不覆盖旧对象，
-- 保证 config 回滚到历史版本时旧海报 URL 仍指向当时的图。
--
-- 执行：GitHub Actions → Database Migration，先 test 后 production。

BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'miniapp-invite-posters',
  'miniapp-invite-posters',
  true,
  10485760, -- 10 MB：2160×3840 的 PNG 海报也在此范围内
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ─── 自检 ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets
    WHERE id = 'miniapp-invite-posters' AND public = true
  ) THEN
    RAISE EXCEPTION '107 自检失败：miniapp-invite-posters 桶未创建';
  END IF;
END;
$$;

COMMIT;
