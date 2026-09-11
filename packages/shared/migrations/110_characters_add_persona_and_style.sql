-- 110: 给 app_core.characters 增加 character_persona_and_style。
--
-- 可空、DEFAULT NULL，存量 457 行无需回填。现网 Prisma schema 与
-- PostgREST 显式列清单都不包含此列：Prisma 只 SELECT 已声明字段，
-- CharacterCardRepository / ChatSessionRepository 也是点名取列，
-- 多一列不会让后端读 schema 报错。不要在本迁移里同步改 Prisma——
-- 先加列、后改客户端，避免「代码先上、列还不在」的窗口。
--
-- 生产 main（wbtsfzozlmurljvglhpn）已通过 Management API 落过同名迁移
-- add_character_persona_and_style（version 20260910123242）。
-- 本文件给 test / 后续环境补跑；生产再跑是 IF NOT EXISTS no-op。
--
-- 锁：ADD COLUMN NULL 只改 catalog，不重写表。仍设 lock_timeout 快速失败。

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE app_core.characters
  ADD COLUMN IF NOT EXISTS character_persona_and_style TEXT DEFAULT NULL;

COMMENT ON COLUMN app_core.characters.character_persona_and_style IS
  '角色人设与文风；NULL 表示尚未填写。现有 Prisma / PostgREST 显式列读取不依赖此列。';

COMMIT;

NOTIFY pgrst, 'reload schema';
