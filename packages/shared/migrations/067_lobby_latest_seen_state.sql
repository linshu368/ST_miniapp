-- 首页「最新」入口的 New 提醒：记录用户最后一次查看「最新」的时间，与角色卡的
-- 最后上架时间比较得出「本轮是否有上新」。
--
-- 上新时间直接用 miniapp.characters.last_listed_at（060 引入）。它的触发器只在
-- 角色卡由「未上架」转为「已上架」时刷新，所以运营做纯排序调整、改头像或改简介
-- 都不会让 New 误亮；这正是 PRD 要求的判定口径，不需要另造上新批次标记。
--
-- 水位线放在 miniapp_user_settings 上而不是新建表：每个用户只需要一个标量，
-- 与 selected_model_id 等既有的单值用户状态同构。

BEGIN;

ALTER TABLE miniapp.miniapp_user_settings
  ADD COLUMN IF NOT EXISTS characters_last_seen_at TIMESTAMPTZ;

COMMENT ON COLUMN miniapp.miniapp_user_settings.characters_last_seen_at IS
  '用户最后一次进入首页「最新」分页的时间；晚于它的角色卡上架即为本轮上新，New 提醒以此为准。';

COMMIT;

NOTIFY pgrst, 'reload schema';
