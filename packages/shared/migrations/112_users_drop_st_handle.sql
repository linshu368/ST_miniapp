-- 112: st_handle 退场第二步——删列。
-- domain: app_core（见 docs/schema归属地图.md）
--
-- 方案与完整顺序：docs/st_handle退场方案.md
--
-- ⚠️ 前置条件，缺一不可：
--   1. 111 已执行（st_handle 已可为 NULL）；
--   2. 停止写入 st_handle 的后端代码**已经上线并观察过一轮**，确认新注册用户
--      st_handle IS NULL 且注册链路无报错；
--   3. 已按下面的命令导出留档（与 087/088 处置平台预设同一口径）。
--
-- 观察期核对：
--   SELECT count(*) FILTER (WHERE st_handle IS NULL)     AS 新号,
--          count(*) FILTER (WHERE st_handle IS NOT NULL) AS 存量
--   FROM app_core.users;
--   （「新号」应随时间增长；为 0 说明代码还没停写，不要往下执行。）
--
-- 删列前导出留档：
--   \copy (SELECT id, tg_id, st_handle, st_initialized_at FROM app_core.users)
--     TO 'st_handle_backup.csv' CSV HEADER
--
-- 本迁移不可回滚：删列即丢弃这份历史映射。它没有任何读取方，但仍是不可逆动作。
-- users_st_handle_key 唯一索引会随 DROP COLUMN 自动删除，无需单独处理。

ALTER TABLE app_core.users DROP COLUMN IF EXISTS st_handle;
ALTER TABLE app_core.users DROP COLUMN IF EXISTS st_initialized_at;

-- 自检：两列都已消失。
DO $$
DECLARE
  v_remaining TEXT;
BEGIN
  SELECT string_agg(column_name, ', ')
    INTO v_remaining
  FROM information_schema.columns
  WHERE table_schema = 'app_core'
    AND table_name = 'users'
    AND column_name IN ('st_handle', 'st_initialized_at');

  IF v_remaining IS NOT NULL THEN
    RAISE EXCEPTION '112 自检失败：app_core.users 仍存在遗留列 %', v_remaining;
  END IF;
END $$;
