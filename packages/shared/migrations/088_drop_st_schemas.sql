-- 088: 下线 ST 三个 schema（st_platform / st_users / st_infra）。
--
-- 前置：087 已删掉 admin 里 9 个引用 st_platform 的 RPC。087 之前 drop 会留下一调就报错的函数。
--
-- 盘点（生产 2026-08-20）：
--   · 应用代码零引用（ST 引擎与运营台预设页已下线）
--   · 库内函数 / 视图 / cron / 外部 FK 全部零引用
--   · 仅有的 FK 是这三个 schema 指向 miniapp.users / miniapp.characters（drop 方向安全）
--   · 生产最后写入 2026-07-22 ~ 07-24，统计窗口内零业务读取
--
-- CASCADE 只会吃掉这三个 schema 自己的表、函数、触发器；不会碰到 miniapp / admin。
-- DROP 时要解掉指向 miniapp.users / miniapp.characters 的 FK，会短暂 ShareRowExclusive
-- 那两张热表。拿不到锁时快速失败重试，避免和业务写入互相等成死锁。
--
-- 数据留档不进 git（含用户镜像）：执行前用 psql COPY 落到本机
-- /tmp/st-schema-archive/{prod,test}/ 。结构回滚走历史迁移 003–012 / 044 / 053 / 068。
--
-- 幂等：IF EXISTS。

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP SCHEMA IF EXISTS st_platform CASCADE;
DROP SCHEMA IF EXISTS st_users CASCADE;
DROP SCHEMA IF EXISTS st_infra CASCADE;

COMMIT;

-- 验证（执行后应返回 0 行）：
--   SELECT nspname FROM pg_namespace
--   WHERE nspname IN ('st_platform','st_users','st_infra');
