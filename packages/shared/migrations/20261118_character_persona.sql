-- Domain: app_core（用户偏好：主角人设库 + 按角色卡的补充设定与人设选择）
-- 设计：.trellis/tasks/11-18-character-persona/design.md；落位规则见 docs/db/CONTRACT.md §2。
--
--   1. app_core.user_personas（E）：用户自己的主角人设库，每人最多 10 个，至多一个默认。
--   2. app_core.user_character_preferences（S）：用户 × 角色卡 的补充设定与人设选择。
--   3. 函数：save_user_persona / delete_user_persona（人设库写入）、
--            get_character_prompt_settings（生成链路读取，一次返回补充设定与生效人设描述）。
--
-- 纯新增对象：没有旧数据、没有回填。
-- 执行顺序：TEST → 生产；先迁移，再部署后端与前端。
-- 回滚：回退后端/前端即可，表保留。如需删除对象（会丢失用户填写的设定，需用户同意）：
--   DROP FUNCTION app_core.get_character_prompt_settings(uuid, uuid);
--   DROP FUNCTION app_core.delete_user_persona(uuid, uuid);
--   DROP FUNCTION app_core.save_user_persona(uuid, uuid, text, text, boolean);
--   DROP TABLE app_core.user_character_preferences;
--   DROP TABLE app_core.user_personas;
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('app_core.users') IS NULL OR to_regclass('app_core.characters') IS NULL THEN
    RAISE EXCEPTION 'character persona: prerequisite tables missing';
  END IF;
  IF to_regclass('app_core.user_personas') IS NOT NULL
     OR to_regclass('app_core.user_character_preferences') IS NOT NULL THEN
    RAISE EXCEPTION 'character persona: target tables already exist';
  END IF;
END
$preflight$;

-- ── 1. 人设库 ───────────────────────────────────────────────────────────────
CREATE TABLE app_core.user_personas (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_personas_pkey PRIMARY KEY (id),
  CONSTRAINT user_personas_user_fkey FOREIGN KEY (user_id)
    REFERENCES app_core.users (id) ON DELETE CASCADE,
  -- 复合外键的目标：让 user_character_preferences 只能选自己的人设。
  CONSTRAINT user_personas_user_id_id_key UNIQUE (user_id, id),
  CONSTRAINT user_personas_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 20),
  CONSTRAINT user_personas_description_check CHECK (char_length(btrim(description)) BETWEEN 1 AND 800)
);
-- 每个用户至多一个默认人设。
CREATE UNIQUE INDEX user_personas_one_default_idx
  ON app_core.user_personas (user_id) WHERE is_default;

COMMENT ON TABLE app_core.user_personas IS
  '用户的主角人设库（用户扮演的人）。只写 save_user_persona / delete_user_persona；随用户级联删除。';
COMMENT ON COLUMN app_core.user_personas.name IS '人设名，≤20 字，只用于用户自己区分，不进 prompt。';
COMMENT ON COLUMN app_core.user_personas.description IS '人设描述，≤800 字，原样写入发给模型的设定。';
COMMENT ON COLUMN app_core.user_personas.is_default IS '没单独选过人设的角色卡使用它；每用户至多一个（部分唯一索引）。';

-- ── 2. 按角色卡的偏好 ───────────────────────────────────────────────────────
CREATE TABLE app_core.user_character_preferences (
  user_id uuid NOT NULL,
  character_id uuid NOT NULL,
  character_notes text NOT NULL DEFAULT '',
  persona_id uuid,
  persona_disabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_character_preferences_pkey PRIMARY KEY (user_id, character_id),
  CONSTRAINT user_character_preferences_user_fkey FOREIGN KEY (user_id)
    REFERENCES app_core.users (id) ON DELETE CASCADE,
  CONSTRAINT user_character_preferences_character_fkey FOREIGN KEY (character_id)
    REFERENCES app_core.characters (id) ON DELETE CASCADE,
  -- 删除人设时只把 persona_id 置空，该卡自动回到"跟随默认"。
  CONSTRAINT user_character_preferences_persona_fkey FOREIGN KEY (user_id, persona_id)
    REFERENCES app_core.user_personas (user_id, id) ON DELETE SET NULL (persona_id),
  CONSTRAINT user_character_preferences_notes_check CHECK (char_length(character_notes) <= 1000),
  CONSTRAINT user_character_preferences_persona_exclusive_check
    CHECK (NOT (persona_disabled AND persona_id IS NOT NULL))
);

COMMENT ON TABLE app_core.user_character_preferences IS
  '用户 × 角色卡 的偏好：补充设定与主角人设选择。无行 = 补充设定为空、人设跟随默认。后端按 (user_id, character_id) upsert；随用户或角色卡级联删除。';
COMMENT ON COLUMN app_core.user_character_preferences.character_notes IS '用户为这张卡补充的设定，≤1000 字，可写多个人物。';
COMMENT ON COLUMN app_core.user_character_preferences.persona_id IS '指定的人设；NULL 且 persona_disabled=false 表示跟随默认人设。';
COMMENT ON COLUMN app_core.user_character_preferences.persona_disabled IS 'true = 这张卡不使用任何人设；与 persona_id 互斥。';

-- ── 3. 访问控制：只给服务端 ─────────────────────────────────────────────────
ALTER TABLE app_core.user_personas ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_core.user_character_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_core.user_personas FROM PUBLIC;
REVOKE ALL ON app_core.user_character_preferences FROM PUBLIC;
DO $acl$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON app_core.user_personas FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON app_core.user_character_preferences FROM %I', v_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    -- 人设库只经 RPC 写，表只读；按卡偏好由后端直接 upsert。
    GRANT SELECT ON app_core.user_personas TO service_role;
    GRANT SELECT, INSERT, UPDATE ON app_core.user_character_preferences TO service_role;
  END IF;
END
$acl$;

-- ── 4. 函数 ─────────────────────────────────────────────────────────────────
-- 人设库保存：p_persona_id 为空 = 新建。数量上限、默认唯一和"第一个自动默认"都在同一事务内，
-- 同一用户的并发保存由 advisory lock 串行化，不会超过 10 个或出现两个默认。
CREATE OR REPLACE FUNCTION app_core.save_user_persona(
  p_user_id uuid, p_persona_id uuid, p_name text, p_description text, p_is_default boolean
) RETURNS app_core.user_personas
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_row app_core.user_personas;
  v_count integer;
  v_default boolean := COALESCE(p_is_default, false);
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user id is required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('app_core.user_personas:' || p_user_id::text, 0));

  IF p_persona_id IS NULL THEN
    SELECT count(*) INTO v_count FROM app_core.user_personas WHERE user_id = p_user_id;
    IF v_count >= 10 THEN
      RAISE EXCEPTION 'persona_limit' USING ERRCODE = '23514';
    END IF;
    IF v_count = 0 THEN v_default := true; END IF;
    IF v_default THEN
      UPDATE app_core.user_personas SET is_default = false, updated_at = clock_timestamp()
      WHERE user_id = p_user_id AND is_default;
    END IF;
    INSERT INTO app_core.user_personas (user_id, name, description, is_default)
    VALUES (p_user_id, btrim(p_name), btrim(p_description), v_default)
    RETURNING * INTO v_row;
  ELSE
    IF v_default THEN
      UPDATE app_core.user_personas SET is_default = false, updated_at = clock_timestamp()
      WHERE user_id = p_user_id AND is_default AND id <> p_persona_id;
    END IF;
    UPDATE app_core.user_personas
    SET name = btrim(p_name), description = btrim(p_description),
        is_default = v_default, updated_at = clock_timestamp()
    WHERE id = p_persona_id AND user_id = p_user_id
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'persona_not_found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  RETURN v_row;
END;
$fn$;
COMMENT ON FUNCTION app_core.save_user_persona(uuid, uuid, text, text, boolean) IS
  '保存主角人设（p_persona_id 为空 = 新建）。上限 10 个；第一个自动成为默认；设为默认会取消原默认。上限错误 23514/persona_limit，不存在 P0002/persona_not_found。';

CREATE OR REPLACE FUNCTION app_core.delete_user_persona(p_user_id uuid, p_persona_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_deleted integer;
BEGIN
  IF p_user_id IS NULL OR p_persona_id IS NULL THEN
    RAISE EXCEPTION 'user id and persona id are required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('app_core.user_personas:' || p_user_id::text, 0));
  -- 选用它的角色卡由复合外键 ON DELETE SET NULL (persona_id) 自动回到"跟随默认"。
  DELETE FROM app_core.user_personas WHERE id = p_persona_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$fn$;
COMMENT ON FUNCTION app_core.delete_user_persona(uuid, uuid) IS
  '删除主角人设，返回是否删到。若删的是默认人设，不会自动指定新的默认。';

-- 生成链路读取：始终返回一行。补充设定为空串、人设描述为空串都表示"这一段不注入"。
CREATE OR REPLACE FUNCTION app_core.get_character_prompt_settings(p_user_id uuid, p_character_id uuid)
RETURNS TABLE (character_notes text, persona_description text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET statement_timeout = '3s'
AS $fn$
  SELECT
    COALESCE(cp.character_notes, ''),
    COALESCE(
      CASE
        WHEN cp.persona_disabled THEN NULL
        WHEN cp.persona_id IS NOT NULL THEN
          (SELECT p.description FROM app_core.user_personas p
           WHERE p.id = cp.persona_id AND p.user_id = p_user_id)
        ELSE
          (SELECT p.description FROM app_core.user_personas p
           WHERE p.user_id = p_user_id AND p.is_default)
      END,
      ''
    )
  FROM (SELECT 1) AS one
  LEFT JOIN app_core.user_character_preferences cp
    ON cp.user_id = p_user_id AND cp.character_id = p_character_id;
$fn$;
COMMENT ON FUNCTION app_core.get_character_prompt_settings(uuid, uuid) IS
  '一次读出某用户在某角色卡上的补充设定与生效人设描述（指定 > 不使用 > 默认）。';

REVOKE ALL ON FUNCTION app_core.save_user_persona(uuid, uuid, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_core.delete_user_persona(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_core.get_character_prompt_settings(uuid, uuid) FROM PUBLIC;
DO $fn_acl$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION app_core.save_user_persona(uuid, uuid, text, text, boolean) FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON FUNCTION app_core.delete_user_persona(uuid, uuid) FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON FUNCTION app_core.get_character_prompt_settings(uuid, uuid) FROM %I', v_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION app_core.save_user_persona(uuid, uuid, text, text, boolean) TO service_role;
    GRANT EXECUTE ON FUNCTION app_core.delete_user_persona(uuid, uuid) TO service_role;
    GRANT EXECUTE ON FUNCTION app_core.get_character_prompt_settings(uuid, uuid) TO service_role;
  END IF;
END
$fn_acl$;

COMMIT;
