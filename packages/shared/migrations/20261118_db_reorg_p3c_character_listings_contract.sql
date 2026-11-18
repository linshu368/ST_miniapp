-- Domain: app_core（角色卡上架状态）——阶段 3c 收缩步。
-- 计划见 .trellis/tasks/11-17-db-reorg-p3-user-state/design.md 3c。
--
-- 前置：20261118_db_reorg_p3c_character_listings.sql 已执行；生产后端已改为读 app_core.character_listings，
--   并核对旧写法停涨（见 design.md 核对步骤）。
-- 步骤（同一事务）：
--   1. 锁两表，删发布窗口镜像；
--   2. 守卫：每张卡恰有上架行且与卡片表 4 列一致（写入方在扩展步已全部换成写上架表，不一致说明有人直接写了旧列，
--      需人工判断，不自动覆盖）；不得再有函数读 characters 的上架列；不得再有视图依赖这 4 列；
--   3. 插卡触发器换成按默认值建上架行（下架、排序 0）；
--   4. 删旧 CHECK、3 个旧索引、旧上架时间触发器函数和 4 列。
--
-- Verify: bash scripts/test-db-reorg-p3c-migration.sh（末段）。
-- Release: TEST -> Production。
-- Recovery: 不可逆；上架状态在 character_listings。必要时给 characters 加回 4 列并从上架表回填。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $contract$
DECLARE
  v_n integer;
  v_ref text;
BEGIN
  IF to_regclass('app_core.character_listings') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'app_core.characters'::regclass
                    AND tgname = 'characters_ensure_listing') THEN
    RAISE EXCEPTION 'apply 20261118_db_reorg_p3c_character_listings.sql first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'app_core' AND table_name = 'characters' AND column_name = 'enabled') THEN
    RETURN;  -- 已收缩（重跑）
  END IF;

  -- 1. 停镜像 ------------------------------------------------------------------
  LOCK TABLE app_core.characters, app_core.character_listings IN ACCESS EXCLUSIVE MODE;
  DROP TRIGGER IF EXISTS character_listings_mirror ON app_core.character_listings;
  DROP FUNCTION IF EXISTS app_core.tf_character_listings_mirror();

  -- 2. 守卫 ----------------------------------------------------------------------
  SELECT count(*) INTO v_n FROM app_core.characters c
  WHERE NOT EXISTS (SELECT 1 FROM app_core.character_listings l WHERE l.character_id = c.id);
  IF v_n > 0 THEN
    RAISE EXCEPTION '% characters have no listing row', v_n;
  END IF;
  SELECT count(*), string_agg(c.id::text, ', ' ORDER BY c.id) INTO v_n, v_ref
  FROM app_core.characters c JOIN app_core.character_listings l ON l.character_id = c.id
  WHERE (c.enabled, c.sort_order, c.archived_at, c.last_listed_at)
        IS DISTINCT FROM (l.enabled, l.sort_order, l.archived_at, l.last_listed_at);
  IF v_n > 0 THEN
    RAISE EXCEPTION '% characters differ from their listing row (someone wrote the old columns directly): %',
      v_n, left(v_ref, 400);
  END IF;

  -- 上架表自己的两个触发器函数读 characters 的 is_test / created_at、写 NEW.enabled 等，不是旧列读者，按名排除。
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_ref
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND p.prosrc ~ 'app_core\.characters\M'
    AND p.prosrc ~ '\m(enabled|sort_order|archived_at|last_listed_at)\M'
    AND position('character_listings' IN p.prosrc) = 0
    AND p.oid NOT IN ('app_core.tf_character_listings_track()'::regprocedure,
                      'app_core.tf_character_listings_guard_test()'::regprocedure);
  IF v_ref IS NOT NULL THEN
    RAISE EXCEPTION 'functions still read listing columns of app_core.characters: %', v_ref;
  END IF;

  SELECT string_agg(DISTINCT v.oid::regclass::text || '(' || a.attname || ')', ', ') INTO v_ref
  FROM pg_depend d
  JOIN pg_rewrite rw ON rw.oid = d.objid
  JOIN pg_class v ON v.oid = rw.ev_class
  JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
  WHERE d.classid = 'pg_rewrite'::regclass AND d.refobjid = 'app_core.characters'::regclass
    AND v.oid <> d.refobjid
    AND a.attname IN ('enabled', 'sort_order', 'archived_at', 'last_listed_at');
  IF v_ref IS NOT NULL THEN
    RAISE EXCEPTION 'views still depend on listing columns of app_core.characters: %', v_ref;
  END IF;

  -- pg_cron 命令是纯文本，删列不会报错，只会在下次执行时失败，单独查。
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $q$SELECT string_agg(jobid::text || ' ' || coalesce(jobname, ''), ', ') FROM cron.job
      WHERE command ~ 'app_core\.characters\M' AND command ~ '\m(enabled|sort_order|archived_at|last_listed_at)\M'
        AND position('character_listings' IN command) = 0$q$ INTO v_ref;
    IF v_ref IS NOT NULL THEN
      RAISE EXCEPTION 'cron jobs still read listing columns of app_core.characters: %', v_ref;
    END IF;
  END IF;

  -- 3. 插卡触发器按默认值建行 -------------------------------------------------------
  CREATE OR REPLACE FUNCTION app_core.tf_characters_ensure_listing()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $fn$
  BEGIN
    INSERT INTO app_core.character_listings (character_id) VALUES (NEW.id)
    ON CONFLICT (character_id) DO NOTHING;
    RETURN NULL;
  END;
  $fn$;
  REVOKE ALL ON FUNCTION app_core.tf_characters_ensure_listing() FROM PUBLIC;

  -- 4. 删旧约束、索引、触发器函数和列 -------------------------------------------------
  ALTER TABLE app_core.characters DROP CONSTRAINT IF EXISTS characters_test_cards_disabled;
  DROP INDEX IF EXISTS app_core.idx_characters_active_order;
  DROP INDEX IF EXISTS app_core.idx_characters_enabled_sort;
  DROP INDEX IF EXISTS app_core.idx_characters_last_listed_at;
  DROP TRIGGER IF EXISTS trg_characters_track_listing ON app_core.characters;
  DROP FUNCTION IF EXISTS app_core.tf_track_character_listing();
  ALTER TABLE app_core.characters
    DROP COLUMN enabled,
    DROP COLUMN sort_order,
    DROP COLUMN archived_at,
    DROP COLUMN last_listed_at;
  COMMENT ON TABLE app_core.characters IS
    '角色卡内容（官方导入、运营新建、用户创作）。上架状态在 app_core.character_listings，创作者状态在 app_core.character_creations。';
  COMMENT ON TABLE app_core.character_listings IS
    '角色卡上架状态（每卡一行，插卡触发器按默认值建行：下架、排序 0）。写入方：运营布局发布（admin.publish_character_layout_draft）、新建卡（admin.create_character）、创作者建卡/发布/审核。';
END
$contract$;

NOTIFY pgrst, 'reload schema';
COMMIT;
