-- 098: 删 miniapp.characters 的三个 ST 同步期死列，把 test 的形态对齐生产。
--
-- 背景：2026-08-25 批次 A 双库盘点发现 characters 的列集合在两库不同——
--   test 31 列 / production 28 列，test 独有 is_default / is_published / is_active。
-- 三列来自 ST 同步期的 004_characters_add_sync_fields.sql；生产侧已被后续
-- Prisma 迁移（20260626150000_character_field_cleanup_fallback_config）摘掉，
-- test 因为没跑那条 Prisma 迁移而留了下来。
--
-- 为什么是死列（2026-08-25 实测取证，见
-- ops/schema-split/snapshots/2026-08-25/批次A-双库基线与差异.md §三 B1）：
--   * 全仓库检索无任何代码引用 characters 的这三列。仓库里 is_published / is_active
--     的命中全部属于 miniapp.notifications、miniapp.chat_message_audio 与
--     admin 公告表，与 characters 无关。
--   * test 库实测：无索引、无约束、无视图、无函数体、无列注释引用这三列。
--   * 上架控制走的是 enabled / sort_order / archived_at，与这三列无关。
--
-- 为什么单独一条迁移而不塞进 099：schema 划分要在单事务里搬 22 表 + 1 视图 + 24 函数，
-- 不该再混进一个与它无关的列变更；出问题时也无法分辨是谁导致的。
--
-- 幂等：全部 IF EXISTS。在生产执行是无操作的 no-op（三列本就不存在），
-- 因此本迁移可以在两库都跑一遍，用来把「形态一致」这件事显式落到迁移流水里。
--
-- 锁：characters 在生产只有 336 行 / 30 MB，DROP COLUMN 只改 catalog。
-- 仍设 lock_timeout 快速失败，避免堵住大厅列表查询。

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE miniapp.characters
  DROP COLUMN IF EXISTS is_default,
  DROP COLUMN IF EXISTS is_published,
  DROP COLUMN IF EXISTS is_active;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- 验证：下面这条应返回 0 行，且两库的 characters 列数应同为 28。
--   SELECT attname FROM pg_attribute
--    WHERE attrelid = 'miniapp.characters'::regclass AND attnum > 0 AND NOT attisdropped
--      AND attname IN ('is_default','is_published','is_active');
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_schema = 'miniapp' AND table_name = 'characters';
