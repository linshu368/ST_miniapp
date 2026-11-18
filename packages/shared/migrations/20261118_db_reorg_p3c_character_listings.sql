-- Domain: app_core（角色卡上架状态）+ admin（运营布局函数）+ miniapp_analytics（分析视图）。
-- 数据库重组阶段 3c（扩展步），规则见 docs/db/CONTRACT.md，计划见 .trellis/tasks/11-17-db-reorg-p3-user-state/design.md 3c。
--
-- 终态：app_core.characters 只留卡内容；上架 4 列 enabled / sort_order / archived_at / last_listed_at
--   在 app_core.character_listings（每卡一行，插卡触发器保证存在）。
-- 本文件（扩展）：
--   1. 建 character_listings 并回填；上架时间触发器、测试卡守卫移到上架表；
--   2. 插卡后自动建上架行（扩展期间按卡片表上那 4 列的值建）；characters.enabled 默认改为 false；
--   3. 删 3 个 0 调用的旧运营函数；运营布局 3 个函数、新建卡、两个可见性函数改读写上架表；
--      创作者发布/审核两个函数按原文只替换涉及上架的几句；分析视图改 join；
--   4. 发布窗口：上架表 → characters 4 列单向镜像，供旧后端读（写入方全部已换成新函数，后端不直接写上架列）；
--   5. pg_cron 每小时位次快照（card_position_hourly_snapshot）改读上架表，写入内容不变。
-- 收缩步（后端发布后）：20261118_db_reorg_p3c_character_listings_contract.sql 删镜像、旧约束/索引/列。
--
-- Verify: bash scripts/test-db-reorg-p3c-migration.sh
-- Release: TEST -> Production -> 后端发布 -> 收缩步。
-- Recovery: characters 上的 4 列仍在且镜像同步；回退后端即可（旧运营函数已删，网页与 CLI 本就不用）。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. 整函数重写前，确认线上版本就是本迁移依据的版本（或已是新版本），避免覆盖别人的改动 ----------
DO $guard$
DECLARE
  r record;
  v_src text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('admin.get_characters()', '4f07ba1b25c8f7d33e1665df218d3288'),
    ('admin.get_character_layout()', 'bb2b7e2b2dda2e9448e54a4db73afc2d'),
    ('admin.publish_character_layout_draft(uuid)', 'fffac1b197945dd3eb6854b184cc3fd7'),
    ('admin.create_character(text,text,text,jsonb,text,text,text,text,text,text,text)', '9203391ec9ef1cdcde800d33a0cbfd0b'),
    ('app_core.can_discover_character(uuid)', 'fd5b9c5d4764da03b28665bddda0506c'),
    ('app_core.can_use_character(uuid,uuid)', '9bc52831ca37bbf6d1c44ec19f510fa8')
  ) AS t(fn, md5sum)
  LOOP
    IF to_regprocedure(r.fn) IS NULL THEN
      RAISE EXCEPTION '% is missing', r.fn;
    END IF;
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure(r.fn);
    IF md5(v_src) <> r.md5sum AND position('character_listings' IN v_src) = 0 THEN
      RAISE EXCEPTION '% differs from the version this migration was written against (md5 %)', r.fn, md5(v_src);
    END IF;
  END LOOP;
END
$guard$;

-- 1. 上架表 -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_core.character_listings (
  character_id uuid PRIMARY KEY REFERENCES app_core.characters(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  archived_at timestamp without time zone,
  last_listed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app_core.character_listings IS
  '角色卡上架状态（每卡一行，插卡触发器保证存在）。写入方：运营布局发布（admin.publish_character_layout_draft）、新建卡、创作者发布/审核、官方卡导入脚本（service_role）。';
COMMENT ON COLUMN app_core.character_listings.archived_at IS '归档（删除）时间，北京时间无时区，沿用原 characters.archived_at 口径。';
COMMENT ON COLUMN app_core.character_listings.last_listed_at IS '最近一次由未上架转为上架的时间；首页「最新」与 New 角标按它排序。';
CREATE INDEX IF NOT EXISTS character_listings_active_order_idx
  ON app_core.character_listings (sort_order) WHERE enabled AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS character_listings_last_listed_idx
  ON app_core.character_listings (last_listed_at DESC) WHERE enabled AND archived_at IS NULL;
ALTER TABLE app_core.character_listings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_core.character_listings FROM PUBLIC;
DO $acl$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON app_core.character_listings FROM %I', v_role);
    END IF;
  END LOOP;
  -- service_role 对 characters 本就有全部权限；这里只给读和改（导入脚本插卡后设上架值），建行由插卡触发器做、删行随卡级联。
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, UPDATE ON app_core.character_listings TO service_role;
  END IF;
END
$acl$;

-- 2. 回填（只在 characters 还有上架列时；updated_at 取卡片原值，运营列表显示不变）----------------
DO $backfill$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'app_core' AND table_name = 'characters' AND column_name = 'enabled') THEN
    INSERT INTO app_core.character_listings AS l (character_id, enabled, sort_order, archived_at, last_listed_at, updated_at)
    SELECT c.id, c.enabled, c.sort_order, c.archived_at, c.last_listed_at, c.updated_at AT TIME ZONE 'Asia/Shanghai'
    FROM app_core.characters c
    ON CONFLICT (character_id) DO NOTHING;
  END IF;
END
$backfill$;

-- 3. 上架表触发器：上架时间、测试卡守卫 ------------------------------------------------
CREATE OR REPLACE FUNCTION app_core.tf_character_listings_track()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  -- 由「未上架」转为「已上架」时刷新；已在架状态下的其它更新不刷新，避免改排序就顶到最新页最前。
  IF NEW.enabled AND NEW.archived_at IS NULL
     AND (TG_OP = 'INSERT' OR OLD.enabled IS DISTINCT FROM TRUE OR OLD.archived_at IS NOT NULL) THEN
    NEW.last_listed_at := now();
  END IF;
  IF NEW.last_listed_at IS NULL THEN
    NEW.last_listed_at := COALESCE(
      (SELECT c.created_at AT TIME ZONE 'Asia/Shanghai' FROM app_core.characters c WHERE c.id = NEW.character_id), now());
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS character_listings_track ON app_core.character_listings;
CREATE TRIGGER character_listings_track
  BEFORE INSERT OR UPDATE OF enabled, archived_at ON app_core.character_listings
  FOR EACH ROW EXECUTE FUNCTION app_core.tf_character_listings_track();

CREATE OR REPLACE FUNCTION app_core.tf_character_listings_guard_test()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF NEW.enabled AND EXISTS (SELECT 1 FROM app_core.characters c WHERE c.id = NEW.character_id AND c.is_test) THEN
    RAISE EXCEPTION 'test cards cannot be listed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS character_listings_guard_test ON app_core.character_listings;
CREATE TRIGGER character_listings_guard_test
  BEFORE INSERT OR UPDATE OF enabled ON app_core.character_listings
  FOR EACH ROW EXECUTE FUNCTION app_core.tf_character_listings_guard_test();

-- 已上架的卡不能改成测试卡（原 CHECK 的另一半）；测试卡必须有 card_hash 留在卡片表。
CREATE OR REPLACE FUNCTION app_core.tf_characters_guard_test()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF NEW.is_test AND NOT OLD.is_test
     AND EXISTS (SELECT 1 FROM app_core.character_listings l WHERE l.character_id = NEW.id AND l.enabled) THEN
    RAISE EXCEPTION 'listed cards cannot become test cards' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS characters_guard_test ON app_core.characters;
CREATE TRIGGER characters_guard_test
  BEFORE UPDATE OF is_test ON app_core.characters
  FOR EACH ROW EXECUTE FUNCTION app_core.tf_characters_guard_test();
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'app_core.characters'::regclass
                 AND conname = 'characters_test_cards_have_hash') THEN
    ALTER TABLE app_core.characters
      ADD CONSTRAINT characters_test_cards_have_hash CHECK (NOT is_test OR card_hash IS NOT NULL);
  END IF;
END
$check$;

-- 4. 插卡自动建上架行；卡片表的上架时间触发器移走 -----------------------------------
-- 扩展期间按卡片表上那 4 列的值建行（兼容旧写法一次写齐的插入）；收缩步换成按默认值建行。
CREATE OR REPLACE FUNCTION app_core.tf_characters_ensure_listing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
BEGIN
  INSERT INTO app_core.character_listings (character_id, enabled, sort_order, archived_at, last_listed_at)
  VALUES (NEW.id, NEW.enabled, NEW.sort_order, NEW.archived_at, NEW.last_listed_at)
  ON CONFLICT (character_id) DO NOTHING;
  RETURN NULL;
END;
$fn$;
DROP TRIGGER IF EXISTS characters_ensure_listing ON app_core.characters;
CREATE TRIGGER characters_ensure_listing
  AFTER INSERT ON app_core.characters
  FOR EACH ROW EXECUTE FUNCTION app_core.tf_characters_ensure_listing();
DROP TRIGGER IF EXISTS trg_characters_track_listing ON app_core.characters;
DO $default$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'app_core' AND table_name = 'characters' AND column_name = 'enabled') THEN
    ALTER TABLE app_core.characters ALTER COLUMN enabled SET DEFAULT false;
  END IF;
END
$default$;

-- 5. 发布窗口镜像：上架表 → characters 4 列（收缩步删除）------------------------------
CREATE OR REPLACE FUNCTION app_core.tf_character_listings_mirror()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
BEGIN
  UPDATE app_core.characters c
  SET enabled = NEW.enabled, sort_order = NEW.sort_order, archived_at = NEW.archived_at, last_listed_at = NEW.last_listed_at
  WHERE c.id = NEW.character_id
    AND (c.enabled, c.sort_order, c.archived_at, c.last_listed_at)
        IS DISTINCT FROM (NEW.enabled, NEW.sort_order, NEW.archived_at, NEW.last_listed_at);
  RETURN NULL;
END;
$fn$;
DROP TRIGGER IF EXISTS character_listings_mirror ON app_core.character_listings;
CREATE TRIGGER character_listings_mirror
  AFTER INSERT OR UPDATE ON app_core.character_listings
  FOR EACH ROW EXECUTE FUNCTION app_core.tf_character_listings_mirror();
REVOKE ALL ON FUNCTION app_core.tf_character_listings_track(), app_core.tf_character_listings_guard_test(),
  app_core.tf_characters_guard_test(), app_core.tf_characters_ensure_listing(), app_core.tf_character_listings_mirror() FROM PUBLIC;

-- 6. 删 0 调用的旧运营函数 ------------------------------------------------------------
DROP FUNCTION IF EXISTS admin.archive_character(uuid);
DROP FUNCTION IF EXISTS admin.set_character_enabled(uuid, boolean);
DROP FUNCTION IF EXISTS admin.reorder_characters(uuid[]);

-- 7. 整函数重写 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin.get_characters()
 RETURNS TABLE(id uuid, name text, description text, avatar_url text, tags jsonb, creator text, first_mes text, creator_notes text, enabled boolean, sort_order integer, archived_at timestamp without time zone, created_at timestamp without time zone, updated_at timestamp without time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'admin is not permitted to access current environment'
      USING ERRCODE = '42501';
  END IF;

  -- updated_at 取卡内容与上架两者较晚的一个：运营改上下架/排序，列表里的更新时间照旧会变。
  RETURN QUERY
  SELECT card.id, card.name, card.description, card.avatar_url, card.tags,
         card.creator, card.first_mes, card.creator_notes, listing.enabled,
         listing.sort_order, listing.archived_at, card.created_at,
         GREATEST(card.updated_at, timezone('Asia/Shanghai', listing.updated_at))
  FROM app_core.characters AS card
  JOIN app_core.character_listings AS listing ON listing.character_id = card.id
  WHERE NOT card.is_test
  ORDER BY (listing.archived_at IS NOT NULL), listing.enabled DESC,
           listing.sort_order ASC, card.created_at DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION admin.get_character_layout()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_environment TEXT := admin.current_environment();
  v_version INTEGER;
  v_draft admin.character_layout_drafts%ROWTYPE;
  v_listed UUID[];
  v_delisted UUID[];
  v_deleted UUID[];
BEGIN
  IF NOT admin.can_access_environment(v_environment) THEN
    RAISE EXCEPTION 'admin is not permitted to access current environment'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(state.layout_version, 0) INTO v_version
  FROM admin.character_layout_state AS state
  WHERE state.environment = v_environment;
  v_version := COALESCE(v_version, 0);

  SELECT COALESCE(array_agg(card.id ORDER BY listing.sort_order, card.created_at DESC), '{}')
    INTO v_listed
  FROM app_core.characters AS card
  JOIN app_core.character_listings AS listing ON listing.character_id = card.id
  WHERE listing.enabled AND listing.archived_at IS NULL AND NOT card.is_test;
  SELECT COALESCE(array_agg(card.id ORDER BY listing.sort_order, card.created_at DESC), '{}')
    INTO v_delisted
  FROM app_core.characters AS card
  JOIN app_core.character_listings AS listing ON listing.character_id = card.id
  WHERE NOT listing.enabled AND listing.archived_at IS NULL AND NOT card.is_test;
  SELECT COALESCE(array_agg(card.id ORDER BY listing.archived_at DESC, card.created_at DESC), '{}')
    INTO v_deleted
  FROM app_core.characters AS card
  JOIN app_core.character_listings AS listing ON listing.character_id = card.id
  WHERE listing.archived_at IS NOT NULL AND NOT card.is_test;

  SELECT draft.* INTO v_draft
  FROM admin.character_layout_drafts AS draft
  WHERE draft.environment = v_environment AND draft.status = 'draft'
  ORDER BY draft.updated_at DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'layout_version', v_version,
    'published', jsonb_build_object(
      'listed_ids', to_jsonb(v_listed),
      'delisted_ids', to_jsonb(v_delisted),
      'deleted_ids', to_jsonb(v_deleted)
    ),
    'draft', CASE WHEN v_draft.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_draft.id,
      'listed_ids', to_jsonb(v_draft.listed_ids),
      'delisted_ids', to_jsonb(v_draft.delisted_ids),
      'deleted_ids', to_jsonb(v_draft.deleted_ids),
      'base_layout_version', v_draft.base_layout_version,
      'updated_at', v_draft.updated_at
    ) END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION admin.publish_character_layout_draft(p_draft_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_environment TEXT := admin.current_environment();
  v_draft admin.character_layout_drafts%ROWTYPE;
  v_version INTEGER;
  v_before JSONB;
BEGIN
  SELECT actor.* INTO v_actor FROM admin.admin_users AS actor WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(v_environment) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('admin.character_layout:' || v_environment));
  SELECT draft.* INTO v_draft
  FROM admin.character_layout_drafts AS draft
  WHERE draft.id = p_draft_id AND draft.environment = v_environment AND draft.status = 'draft'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active character layout draft not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM admin.validate_character_layout(v_draft.listed_ids, v_draft.delisted_ids, v_draft.deleted_ids);

  INSERT INTO admin.character_layout_state(environment)
  VALUES (v_environment) ON CONFLICT (environment) DO NOTHING;
  SELECT state.layout_version INTO v_version
  FROM admin.character_layout_state AS state
  WHERE state.environment = v_environment FOR UPDATE;
  IF v_draft.base_layout_version <> v_version THEN
    RAISE EXCEPTION 'character layout version changed; refresh before publishing'
      USING ERRCODE = '40001';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
    'id', listing.character_id, 'enabled', listing.enabled, 'sort_order', listing.sort_order,
    'archived_at', listing.archived_at
  ) ORDER BY listing.character_id) INTO v_before FROM app_core.character_listings AS listing;

  -- 只改上架状态；卡内容（含 characters.updated_at）不动。
  UPDATE app_core.character_listings AS listing
  SET enabled = true, archived_at = NULL, sort_order = ordered.position - 1, updated_at = now()
  FROM unnest(v_draft.listed_ids) WITH ORDINALITY AS ordered(id, position)
  WHERE listing.character_id = ordered.id;

  UPDATE app_core.character_listings AS listing
  SET enabled = false, archived_at = NULL, updated_at = now()
  WHERE listing.character_id = ANY(v_draft.delisted_ids);

  UPDATE app_core.character_listings AS listing
  SET enabled = false,
      archived_at = COALESCE(listing.archived_at, timezone('Asia/Shanghai', now())),
      updated_at = now()
  WHERE listing.character_id = ANY(v_draft.deleted_ids);

  v_version := v_version + 1;
  UPDATE admin.character_layout_state
  SET layout_version = v_version, updated_at = now()
  WHERE environment = v_environment;
  UPDATE admin.character_layout_drafts
  SET status = 'published', published_at = now(), updated_at = now()
  WHERE id = v_draft.id;
  INSERT INTO admin.character_layout_releases(
    environment, layout_version, listed_ids, delisted_ids, deleted_ids,
    source_draft_id, released_by
  ) VALUES (
    v_environment, v_version, v_draft.listed_ids, v_draft.delisted_ids,
    v_draft.deleted_ids, v_draft.id, v_actor.user_id
  );
  INSERT INTO admin.audit_logs(
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, v_environment, 'character.layout.publish',
    'app_core', 'character_listings', v_version::TEXT, v_before,
    jsonb_build_object('layout_version', v_version, 'listed_ids', v_draft.listed_ids,
                       'delisted_ids', v_draft.delisted_ids, 'deleted_ids', v_draft.deleted_ids)
  );
  RETURN v_version;
END;
$function$;

-- 返回类型从 app_core.characters 行类型改为 jsonb（键不变：卡字段 + 上架字段），删列后形状也不变。
DO $create_fn$
BEGIN
  IF (SELECT prorettype FROM pg_proc
      WHERE oid = 'admin.create_character(text,text,text,jsonb,text,text,text,text,text,text,text)'::regprocedure)
     <> 'jsonb'::regtype THEN
    DROP FUNCTION admin.create_character(text,text,text,jsonb,text,text,text,text,text,text,text);
  END IF;
END
$create_fn$;
CREATE OR REPLACE FUNCTION admin.create_character(p_name text, p_description text DEFAULT ''::text, p_avatar_url text DEFAULT ''::text, p_tags jsonb DEFAULT '[]'::jsonb, p_creator text DEFAULT ''::text, p_first_mes text DEFAULT ''::text, p_creator_notes text DEFAULT ''::text, p_personality text DEFAULT ''::text, p_scenario text DEFAULT ''::text, p_system_prompt text DEFAULT ''::text, p_mes_example text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_environment TEXT := admin.current_environment();
  v_character record;
  v_listing record;
  v_next_order INTEGER;
  v_now TIMESTAMP WITHOUT TIME ZONE := timezone('Asia/Shanghai', now());
BEGIN
  SELECT actor.* INTO v_actor
  FROM admin.admin_users AS actor
  WHERE actor.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(v_environment) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  p_name := btrim(COALESCE(p_name, ''));
  p_description := btrim(COALESCE(p_description, ''));
  p_avatar_url := btrim(COALESCE(p_avatar_url, ''));
  p_creator := btrim(COALESCE(p_creator, ''));

  IF length(p_name) < 1 OR length(p_name) > 120 THEN
    RAISE EXCEPTION 'character name must contain 1 to 120 characters'
      USING ERRCODE = '22023';
  END IF;
  IF length(p_description) > 4000 OR length(COALESCE(p_first_mes, '')) > 20000
     OR length(COALESCE(p_creator_notes, '')) > 20000
     OR length(COALESCE(p_personality, '')) > 20000
     OR length(COALESCE(p_scenario, '')) > 20000
     OR length(COALESCE(p_system_prompt, '')) > 30000
     OR length(COALESCE(p_mes_example, '')) > 30000 THEN
    RAISE EXCEPTION 'character text field exceeds the allowed length'
      USING ERRCODE = '22023';
  END IF;
  IF p_avatar_url <> '' AND p_avatar_url !~* '^https://[^[:space:]]+$' THEN
    RAISE EXCEPTION 'avatar URL must be an HTTPS URL' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(COALESCE(p_tags, '[]'::JSONB)) IS DISTINCT FROM 'array'
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(p_tags, '[]'::JSONB)) AS tag(value)
       WHERE jsonb_typeof(tag.value) IS DISTINCT FROM 'string'
          OR length(btrim(tag.value #>> '{}')) > 40
     ) THEN
    RAISE EXCEPTION 'tags must be an array of strings up to 40 characters'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('admin.character_layout:' || v_environment));
  SELECT LEAST(COALESCE(max(listing.sort_order), -1) + 1, 2147483646) INTO v_next_order
  FROM app_core.character_listings AS listing
  WHERE listing.sort_order < 2147483647;

  INSERT INTO app_core.characters(
    name, description, avatar_url, tags, creator, first_mes, creator_notes,
    personality, scenario, system_prompt, mes_example,
    spec, spec_version, raw_card,
    created_at, updated_at
  ) VALUES (
    p_name, p_description, p_avatar_url, COALESCE(p_tags, '[]'::JSONB),
    p_creator, COALESCE(p_first_mes, ''), COALESCE(p_creator_notes, ''),
    COALESCE(p_personality, ''), COALESCE(p_scenario, ''),
    COALESCE(p_system_prompt, ''), COALESCE(p_mes_example, ''),
    'chara_card_v2', '2.0',
    jsonb_build_object(
      'spec', 'chara_card_v2',
      'spec_version', '2.0',
      'data', jsonb_build_object(
        'name', p_name,
        'description', p_description,
        'personality', COALESCE(p_personality, ''),
        'scenario', COALESCE(p_scenario, ''),
        'first_mes', COALESCE(p_first_mes, ''),
        'mes_example', COALESCE(p_mes_example, ''),
        'creator_notes', COALESCE(p_creator_notes, ''),
        'system_prompt', COALESCE(p_system_prompt, ''),
        'tags', COALESCE(p_tags, '[]'::JSONB),
        'creator', p_creator
      )
    ),
    v_now, v_now
  ) RETURNING * INTO v_character;

  -- 插卡触发器已建好上架行（下架）；新卡排在官方卡最后，等布局发布再上架。
  UPDATE app_core.character_listings
  SET enabled = false, archived_at = NULL, sort_order = v_next_order, updated_at = now()
  WHERE character_id = v_character.id
  RETURNING * INTO v_listing;

  UPDATE admin.character_layout_drafts AS draft
  SET delisted_ids = draft.delisted_ids || v_character.id,
      updated_by = v_actor.user_id,
      updated_at = now()
  WHERE draft.environment = v_environment
    AND draft.status = 'draft'
    AND NOT v_character.id = ANY(
      draft.listed_ids || draft.delisted_ids || draft.deleted_ids
    );

  INSERT INTO admin.audit_logs(
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, v_environment, 'character.create',
    'app_core', 'characters', v_character.id::TEXT,
    jsonb_build_object(
      'id', v_character.id,
      'name', v_character.name,
      'enabled', v_listing.enabled,
      'sort_order', v_listing.sort_order,
      'avatar_url', v_character.avatar_url,
      'draft_state', 'delisted'
    )
  );

  RETURN to_jsonb(v_character) || jsonb_build_object(
    'enabled', v_listing.enabled, 'sort_order', v_listing.sort_order,
    'archived_at', v_listing.archived_at, 'last_listed_at', v_listing.last_listed_at);
END;
$function$;
REVOKE ALL ON FUNCTION admin.create_character(text,text,text,jsonb,text,text,text,text,text,text,text) FROM PUBLIC;
DO $create_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION admin.create_character(text,text,text,jsonb,text,text,text,text,text,text,text) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION admin.create_character(text,text,text,jsonb,text,text,text,text,text,text,text) TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION admin.create_character(text,text,text,jsonb,text,text,text,text,text,text,text) TO service_role;
  END IF;
END
$create_acl$;

CREATE OR REPLACE FUNCTION app_core.can_discover_character(p_character_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
 SELECT EXISTS(SELECT 1 FROM app_core.character_listings l LEFT JOIN app_core.character_creations cr ON cr.character_id=l.character_id
 WHERE l.character_id=p_character_id AND l.enabled AND l.archived_at IS NULL
 AND (cr.character_id IS NULL OR (cr.state='ready' AND cr.visibility='public' AND cr.approved_revision IS NOT NULL)))
$function$;

CREATE OR REPLACE FUNCTION app_core.can_use_character(p_user_id uuid, p_character_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
 SELECT EXISTS(SELECT 1 FROM app_core.character_listings l LEFT JOIN app_core.character_creations cr ON cr.character_id=l.character_id
 WHERE l.character_id=p_character_id AND l.enabled AND l.archived_at IS NULL AND (
 cr.character_id IS NULL OR cr.owner_user_id=p_user_id OR
 (cr.state='ready' AND ((cr.visibility='public' AND cr.approved_revision IS NOT NULL) OR
 EXISTS(SELECT 1 FROM app_core.character_access_grants g WHERE g.character_id=l.character_id AND g.user_id=p_user_id)))))
$function$;

-- 8. 创作者两个函数：只替换涉及上架的几句（按原文定位，匹配不是恰好一处就拒绝）--------------
DO $creator$
DECLARE
  r record;
  v_def text;
  v_hits integer;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    -- 建卡：卡片表只插内容，上架行由触发器建好后改成在架、排在最后（创作卡可见性由 character_creations 决定）。
    (1, 'app_core.mutate_creator_character(uuid,uuid,text,integer,jsonb)',
     $p$INSERT INTO app_core\.characters\(id,name,enabled,sort_order\) VALUES\(p_character_id,'',true,2147483647\);$p$,
     $n$INSERT INTO app_core.characters(id,name) VALUES(p_character_id,'');
   UPDATE app_core.character_listings SET enabled=true,sort_order=2147483647,updated_at=now() WHERE character_id=p_character_id;$n$),
    -- 发布：卡片表不再写 last_listed_at，首次审核通过时刷新上架表。
    (2, 'app_core.mutate_creator_character(uuid,uuid,text,integer,jsonb)',
     $p$last_listed_at=CASE WHEN r\.visibility='public' AND r\.review_status='approved'\s+AND \(SELECT approved_revision IS NULL FROM app_core\.character_creations WHERE character_id=p_character_id\)\s+THEN now\(\) ELSE last_listed_at END,\s+updated_at=now\(\) WHERE id=p_character_id;$p$,
     $n$updated_at=now() WHERE id=p_character_id;
     UPDATE app_core.character_listings SET last_listed_at=now(),updated_at=now()
       WHERE character_id=p_character_id AND r.visibility='public' AND r.review_status='approved'
         AND (SELECT approved_revision IS NULL FROM app_core.character_creations WHERE character_id=p_character_id);$n$),
    -- 审核通过：同上。
    (3, 'app_core.review_creator_character(uuid,uuid,integer,text,text,text)',
     $p$last_listed_at=CASE WHEN r\.approved_revision IS NULL THEN now\(\) ELSE last_listed_at END,updated_at=now\(\)\s+WHERE id=p_character_id;$p$,
     $n$updated_at=now()
   WHERE id=p_character_id;
   UPDATE app_core.character_listings SET last_listed_at=now(),updated_at=now()
   WHERE character_id=p_character_id AND r.approved_revision IS NULL;$n$)
  ) AS t(step, fn, pattern, replacement)
  ORDER BY step
  LOOP
    v_def := replace(pg_get_functiondef(to_regprocedure(r.fn)), E'\r', '');
    IF position('character_listings' IN v_def) > 0 AND r.step <> 2 THEN
      CONTINUE;  -- 已改（重跑）；step 2 与 step 1 同函数，由 step 1 判定
    END IF;
    IF r.step = 2 AND position('UPDATE app_core.character_listings SET last_listed_at' IN v_def) > 0 THEN
      CONTINUE;
    END IF;
    SELECT count(*) INTO v_hits FROM regexp_matches(v_def, r.pattern, 'g');
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '% step %: expected exactly one match, found %; refusing to rewrite', r.fn, r.step, v_hits;
    END IF;
    v_def := regexp_replace(v_def, r.pattern, r.replacement);
    EXECUTE v_def;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc
             WHERE oid IN ('app_core.mutate_creator_character(uuid,uuid,text,integer,jsonb)'::regprocedure,
                           'app_core.review_creator_character(uuid,uuid,integer,text,text,text)'::regprocedure)
               AND prosrc ~ '\mlast_listed_at=CASE') THEN
    RAISE EXCEPTION 'creator functions still write characters.last_listed_at';
  END IF;
END
$creator$;

-- 9. 分析视图改 join 上架表（列不变）-------------------------------------------------------
CREATE OR REPLACE VIEW miniapp_analytics.v_card_quality_session AS
 SELECT c.name,
    c.id,
    l.enabled,
    l.sort_order,
    COALESCE(s.n_c, 0) AS user_cnt,
    COALESCE(s.k_c, 0) AS r48_eligible_user_cnt,
    round(s.d30_shrunk::numeric, 4) AS d30_score,
    round(s.r48_raw::numeric, 4) AS r48_score,
    s.score AS final_score,
    s.window_days,
    s.computed_at,
        CASE
            WHEN s.n_c >= 20 AND s.d30_shrunk IS NOT NULL THEN round((100.0::double precision * (0.75::double precision * GREATEST(0.0::double precision, LEAST(1.0::double precision, (s.d30_shrunk - 0.407823074175645::double precision) / (0.543018423396861 - 0.407823074175645)::double precision)) + 0.25::double precision * (LEAST(s.k_c::numeric / 40.0, 1.0)::double precision *
            CASE
                WHEN s.r48_raw IS NULL THEN 0.5::double precision
                ELSE GREATEST(0.0::double precision, LEAST(1.0::double precision, (s.r48_raw - 0.10605434609884::double precision) / (0.20198105081826 - 0.10605434609884)::double precision))
            END + (1.0::double precision - LEAST(s.k_c::numeric / 40.0, 1.0)::double precision) * 0.5::double precision)))::numeric, 2)
            ELSE NULL::numeric
        END AS absolute_score,
    l.last_listed_at
   FROM app_core.characters c
     JOIN app_core.character_listings l ON l.character_id = c.id
     LEFT JOIN miniapp_features.character_ranking_scores s ON s.character_id = c.id
  WHERE l.enabled = true
  ORDER BY s.score DESC NULLS LAST, s.d30_shrunk DESC NULLS LAST, s.r48_raw DESC NULLS LAST, s.n_c DESC NULLS LAST, c.id;

-- 10. pg_cron 每小时位次快照（card_position_hourly_snapshot）改读上架表，写入内容不变 ------------------
-- cron 命令是纯文本，不在函数守卫里；命令与预期原文不一致就拒绝，不猜着改。只能用 cron.alter_job 原地改
-- （Supabase 上 postgres 不能直接 UPDATE cron.job）。TEST 没有 pg_cron，跳过。
DO $cron$
DECLARE
  r record;
  c_old constant text := 'INSERT INTO miniapp_analytics.card_position_snapshot (character_id, name, sort_order, enabled) '
    'SELECT id, name, sort_order, enabled FROM app_core.characters '
    'WHERE enabled = true AND COALESCE(is_test,false) = false AND archived_at IS NULL';
  c_new constant text := 'INSERT INTO miniapp_analytics.card_position_snapshot (character_id, name, sort_order, enabled)
    SELECT c.id, c.name, l.sort_order, l.enabled
    FROM app_core.characters c JOIN app_core.character_listings l ON l.character_id = c.id
    WHERE l.enabled AND l.archived_at IS NULL AND NOT c.is_test';
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;
  FOR r IN EXECUTE $q$SELECT jobid, command FROM cron.job WHERE command LIKE '%card_position_snapshot%'$q$ LOOP
    IF position('character_listings' IN r.command) > 0 THEN
      CONTINUE;  -- 已改（重跑）
    END IF;
    IF rtrim(btrim(regexp_replace(r.command, '\s+', ' ', 'g')), ';') <> c_old THEN
      RAISE EXCEPTION 'cron job % differs from the expected card position snapshot command; refusing to rewrite: %',
        r.jobid, r.command;
    END IF;
    EXECUTE 'SELECT cron.alter_job(job_id => $1, command => $2)' USING r.jobid, c_new;
  END LOOP;
END
$cron$;

NOTIFY pgrst, 'reload schema';
COMMIT;
