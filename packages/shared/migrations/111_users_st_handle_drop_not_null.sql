-- 111: st_handle 退场第一步——放松约束，让代码可以停止写入。
-- domain: app_core（见 docs/schema归属地图.md）
--
-- 方案与完整顺序：docs/st_handle退场方案.md
--
-- 背景：st_handle 是 ST 链路唯一还在被写入的遗留物。ST 的代码、schema、部署单元
-- 都已退场（ARCHITECTURE.md §9），但 028 把这一列建成了 NOT NULL UNIQUE，
-- 所以 lib/user.ts 建号时至今必须派生一个值填进去。业务侧**只写不读**：
-- 身份识别全部走 tg_id。
--
-- ⚠️ 执行顺序是硬约束：**本迁移必须先于「停止写入 st_handle」的代码上线**。
--    反过来做，所有新用户注册都会因 NOT NULL 违反而失败。
--
-- 本迁移只放松约束、不删列不删数据，因此新旧两版代码都能正常跑，
-- 给部署留出安全窗口。删列是 112，需等观察期结束。
--
-- UNIQUE 约束保留：Postgres 的 UNIQUE 允许多行 NULL，新号不写值不会互相冲突。

ALTER TABLE app_core.users ALTER COLUMN st_handle DROP NOT NULL;

COMMENT ON COLUMN app_core.users.st_handle IS
  '【已退场，待 112 删除】ST 用户 handle。业务已不再写入也不读取，身份一律用 tg_id。';

-- 自检：约束确实放松了，否则后续代码上线会炸注册链路。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'app_core'
      AND table_name = 'users'
      AND column_name = 'st_handle'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION '111 自检失败：app_core.users.st_handle 仍是 NOT NULL';
  END IF;
END $$;
