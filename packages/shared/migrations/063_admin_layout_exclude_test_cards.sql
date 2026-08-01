-- 运营后台角色布局排除上线前评测用的测试卡。
--
-- 背景：`miniapp.characters` 上存在 `is_test` 列与 `characters_test_cards_disabled` 约束
-- （测试卡必须保持 enabled = false），由模拟评测通道引入；而 045 建立的布局草稿/发布 RPC
-- 早于该列，至今仍把布局中的每张卡无条件写成 enabled = true。由此产生两个故障：
--
--   1. 运营把测试卡放进「已上架」区后发布，整个发布事务被上述约束拒绝，一张卡都发不出去，
--      界面上只看到裸的 Postgres 约束报错。
--   2. 测试卡计入 `miniapp.characters` 总数，使 `validate_character_layout` 的
--      「三个分桶合计 = 角色总数」不变量与历史发布快照不再相等，回滚任何历史版本都会失败。
--
-- 处理：布局系统只管理非测试卡——运营列表不再返回测试卡，分桶不变量按非测试卡计数，
-- 校验显式拒绝测试卡，并清理现存草稿与历史发布快照里已经混入的测试卡。
-- 测试卡的上下架仍由评测通道自己负责。
--
-- 函数签名全部保持不变，因此使用 CREATE OR REPLACE 覆盖，原有 REVOKE/GRANT 继续有效。

BEGIN;

-- 运营后台角色列表的唯一数据源。测试卡不属于运营视野，一并从源头过滤，
-- 运营就不会再把它拖进上架区。
CREATE OR REPLACE FUNCTION admin.get_characters()
RETURNS TABLE (
  id UUID,
  name TEXT,
  description TEXT,
  avatar_url TEXT,
  tags JSONB,
  creator TEXT,
  first_mes TEXT,
  creator_notes TEXT,
  enabled BOOLEAN,
  sort_order INTEGER,
  archived_at TIMESTAMP WITHOUT TIME ZONE,
  created_at TIMESTAMP WITHOUT TIME ZONE,
  updated_at TIMESTAMP WITHOUT TIME ZONE
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'admin is not permitted to access current environment'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT card.id, card.name, card.description, card.avatar_url, card.tags,
         card.creator, card.first_mes, card.creator_notes, card.enabled,
         card.sort_order, card.archived_at, card.created_at, card.updated_at
  FROM miniapp.characters AS card
  WHERE NOT card.is_test
  ORDER BY (card.archived_at IS NOT NULL), card.enabled DESC,
           card.sort_order ASC, card.created_at DESC;
END;
$$;

-- 已发布布局快照同样按非测试卡口径返回，否则草稿基线一保存就会与校验口径打架。
CREATE OR REPLACE FUNCTION admin.get_character_layout()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
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

  SELECT COALESCE(array_agg(card.id ORDER BY card.sort_order, card.created_at DESC), '{}')
    INTO v_listed
  FROM miniapp.characters AS card
  WHERE card.enabled AND card.archived_at IS NULL AND NOT card.is_test;
  SELECT COALESCE(array_agg(card.id ORDER BY card.sort_order, card.created_at DESC), '{}')
    INTO v_delisted
  FROM miniapp.characters AS card
  WHERE NOT card.enabled AND card.archived_at IS NULL AND NOT card.is_test;
  SELECT COALESCE(array_agg(card.id ORDER BY card.archived_at DESC, card.created_at DESC), '{}')
    INTO v_deleted
  FROM miniapp.characters AS card
  WHERE card.archived_at IS NOT NULL AND NOT card.is_test;

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
$$;

-- 分桶不变量改按非测试卡计数，并在测试卡混入时给出可读原因；
-- 先判测试卡再判分桶，否则运营只会看到「必须恰好覆盖每张角色一次」这种指不出问题在哪的报错。
CREATE OR REPLACE FUNCTION admin.validate_character_layout(
  p_listed_ids UUID[],
  p_delisted_ids UUID[],
  p_deleted_ids UUID[]
) RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_all UUID[] := COALESCE(p_listed_ids, '{}') || COALESCE(p_delisted_ids, '{}') ||
                  COALESCE(p_deleted_ids, '{}');
  v_character_count INTEGER;
  v_unique_count INTEGER;
  v_test_names TEXT;
BEGIN
  SELECT string_agg(card.name, '、' ORDER BY card.name) INTO v_test_names
  FROM miniapp.characters AS card
  WHERE card.is_test
    AND EXISTS (SELECT 1 FROM unnest(v_all) AS item(id) WHERE item.id = card.id);

  IF v_test_names IS NOT NULL THEN
    RAISE EXCEPTION 'character layout must not contain evaluation test cards: %', v_test_names
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_character_count
  FROM miniapp.characters AS card
  WHERE NOT card.is_test;
  SELECT count(DISTINCT item.id) INTO v_unique_count FROM unnest(v_all) AS item(id);

  IF cardinality(v_all) <> v_character_count OR v_unique_count <> v_character_count
     OR EXISTS (
       SELECT 1 FROM unnest(v_all) AS item(id)
       WHERE NOT EXISTS (SELECT 1 FROM miniapp.characters AS card WHERE card.id = item.id)
     ) THEN
    RAISE EXCEPTION 'character layout must partition every character exactly once'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

-- 从 UUID 数组里剔除测试卡，保持原相对顺序。草稿与历史发布快照共用。
CREATE OR REPLACE FUNCTION admin._layout_ids_without_test_cards(p_ids UUID[])
RETURNS UUID[]
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT COALESCE(ARRAY(
    SELECT entry.id
    FROM unnest(COALESCE(p_ids, '{}')) WITH ORDINALITY AS entry(id, ord)
    WHERE NOT EXISTS (
      SELECT 1 FROM miniapp.characters AS card WHERE card.id = entry.id AND card.is_test
    )
    ORDER BY entry.ord
  ), '{}'::UUID[]);
$$;

-- 清理现存草稿：测试卡已经被运营存进了分桶，若不剔除，改完校验后草稿依旧发不出去。
UPDATE admin.character_layout_drafts AS draft
SET listed_ids = admin._layout_ids_without_test_cards(draft.listed_ids),
    delisted_ids = admin._layout_ids_without_test_cards(draft.delisted_ids),
    deleted_ids = admin._layout_ids_without_test_cards(draft.deleted_ids),
    updated_at = now()
WHERE draft.status = 'draft'
  AND (
    draft.listed_ids IS DISTINCT FROM admin._layout_ids_without_test_cards(draft.listed_ids)
    OR draft.delisted_ids IS DISTINCT FROM admin._layout_ids_without_test_cards(draft.delisted_ids)
    OR draft.deleted_ids IS DISTINCT FROM admin._layout_ids_without_test_cards(draft.deleted_ids)
  );

-- 历史发布快照同样剔除测试卡，否则回滚旧版本时 validate 会因「分桶总数 ≠ 非测试卡总数」失败。
UPDATE admin.character_layout_releases AS release
SET listed_ids = admin._layout_ids_without_test_cards(release.listed_ids),
    delisted_ids = admin._layout_ids_without_test_cards(release.delisted_ids),
    deleted_ids = admin._layout_ids_without_test_cards(release.deleted_ids)
WHERE release.listed_ids IS DISTINCT FROM admin._layout_ids_without_test_cards(release.listed_ids)
   OR release.delisted_ids IS DISTINCT FROM admin._layout_ids_without_test_cards(release.delisted_ids)
   OR release.deleted_ids IS DISTINCT FROM admin._layout_ids_without_test_cards(release.deleted_ids);

DROP FUNCTION IF EXISTS admin._layout_ids_without_test_cards(UUID[]);

COMMIT;
