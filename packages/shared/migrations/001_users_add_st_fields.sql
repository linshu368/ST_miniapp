-- 001: 扩展 users 表，添加 ST 身份映射字段
-- 分区归属：身份/系统类（跨分区，不参与双向同步）
-- 数据流：Bridge 登录时确定性派生写入一次，之后不变；同步引擎只读

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS st_handle TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS st_initialized_at TIMESTAMPTZ;

COMMENT ON COLUMN public.users.st_handle IS
  '[partition=identity][shape=-][direction=none] ST 用户 handle，格式 tg_<tg_id>，与 ST data/<handle>/ 目录对应。派生规则见 DECISIONS.md D001';
COMMENT ON COLUMN public.users.st_initialized_at IS
  '[partition=identity][shape=-][direction=none] 首次 Supabase→ST 同步完成的时间戳，NULL 表示尚未初始化';
