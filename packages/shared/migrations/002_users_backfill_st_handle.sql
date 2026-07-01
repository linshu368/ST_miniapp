-- 002: 回填现有用户的 st_handle
-- 规则：tg_<tg_id>，确定性派生，幂等可重跑

UPDATE public.users
SET st_handle = 'tg_' || tg_id
WHERE st_handle IS NULL;
