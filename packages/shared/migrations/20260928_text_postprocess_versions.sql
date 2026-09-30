-- 20260928_text_postprocess_versions.sql
-- domain: app_core（已发布运行快照与 runtime_config 当前值）
--         admin（草稿、发布记录、审计；不把运行快照放进 admin）
--
-- 归属（design §5，按 schema-and-object-conventions 判定）：
--   app_core.text_postprocess_versions
--     真相：某次已发布展示规则的不可变快照。历史消息要按当时版本渲染，
--     不能依赖 admin.config_releases 的 100 条窗口。
--     不变量：version 正整数且只增；source/schema_version/policy_version/published_at
--     写入后不可 UPDATE/DELETE。权威写入方只有本文件的专用发布/回滚 RPC。
--     生命周期：至少保留全部消息引用；首期不 GC。功能下线后已发布历史仍要可读。
--     消费者：Backend 经 service_role 读取；APP 不直连。
--     为何不是 miniapp_features：删除“后处理功能”后，已绑定消息仍要读到原快照，
--     它是运行配置的历史，不是某个功能自己的投影。
--     为何不是 admin：admin 拥有编辑/发布过程；APP 读历史展示时不能碰草稿和审计。
--   app_core.runtime_config key = miniapp_text_postprocess_config
--     真相：当前已发布版本。没有该行表示尚未发布，读方按 null 处理。本迁移不播种规则。
--   admin.config_drafts / config_releases / audit_logs
--     沿用既有运营对象。本 key 只允许专用 RPC 写入。
--
-- 跨 schema：专用 RPC 在同一事务写
--   app_core.text_postprocess_versions、app_core.runtime_config、
--   admin.config_releases、admin.audit_logs，发布时再标记 admin.config_drafts。
--   不读业务行，不建幂等副表。request_id 落在 audit_logs。
--
-- 通用 publish/rollback/upsert/save/discard 只插入显式拒绝，不重写其原有正文。
-- 拒绝锚点来自仓库当前函数体（035/037/039；099 只替换 miniapp.runtime_config）。
-- 锚点缺失则迁移失败，避免静默漏补。
--
-- 锁：admin 表很小。lock_timeout 5s，statement_timeout 5min（审计唯一索引可能扫 audit_logs）。
-- 不回填。失败则整文件回滚（本文件单事务）；已提交后的修正用新迁移，不改本文件。
-- 前置：099 已完成；admin 草稿/发布函数与 app_core.runtime_config 已在目标库。
-- 执行：先本文件，再 20260928_chat_history_postprocess_version.sql。TEST/Production 分开审批。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

DO $preflight$
BEGIN
  IF to_regclass('admin.config_drafts') IS NULL
     OR to_regclass('admin.config_releases') IS NULL
     OR to_regclass('admin.audit_logs') IS NULL
     OR to_regclass('admin.admin_users') IS NULL
     OR to_regclass('app_core.runtime_config') IS NULL
     OR to_regprocedure('admin.current_environment()') IS NULL
     OR to_regprocedure('admin.publish_config_draft(uuid)') IS NULL
     OR to_regprocedure('admin.rollback_config_release(uuid)') IS NULL
     OR to_regprocedure('admin.upsert_config_draft(text,text,jsonb,text,text)') IS NULL
     OR to_regprocedure('admin.save_config_draft(text,text,jsonb,text,text)') IS NULL
     OR to_regprocedure('admin.discard_config_draft(uuid)') IS NULL THEN
    RAISE EXCEPTION '20260928_text_postprocess_versions preflight: admin config prerequisites missing';
  END IF;
END
$preflight$;

-- 只放宽 CHECK，不替换整份 key 列表，避免丢掉其他迁移后加入的 key。
DO $widen$
DECLARE
  v_table regclass;
  v_constraint_name text;
  v_existing_expression text;
  v_key constant text := 'miniapp_text_postprocess_config';
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'admin.config_drafts'::regclass,
    'admin.config_releases'::regclass
  ] LOOP
    v_constraint_name := CASE v_table
      WHEN 'admin.config_drafts'::regclass THEN 'config_drafts_config_key_check'
      ELSE 'config_releases_config_key_check'
    END;

    SELECT pg_get_expr(c.conbin, c.conrelid)
      INTO v_existing_expression
    FROM pg_constraint AS c
    WHERE c.conrelid = v_table
      AND c.conname = v_constraint_name
      AND c.contype = 'c';

    IF v_existing_expression IS NULL THEN
      RAISE EXCEPTION 'missing expected constraint %.%', v_table, v_constraint_name;
    END IF;
    IF position(v_key IN v_existing_expression) > 0 THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_table, v_constraint_name);
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I CHECK ((%s) OR config_key = %L)',
      v_table,
      v_constraint_name,
      v_existing_expression,
      v_key
    );
  END LOOP;
END
$widen$;

ALTER TABLE admin.config_drafts
  ADD COLUMN IF NOT EXISTS content_digest text;

ALTER TABLE admin.audit_logs
  ADD COLUMN IF NOT EXISTS request_id uuid,
  ADD COLUMN IF NOT EXISTS request_digest text;

COMMENT ON COLUMN admin.config_drafts.content_digest IS
  '文本后处理草稿 source 的调用方 SHA-256（canonical JSON，64 位小写十六进制）。其他 key 保持 NULL。';
COMMENT ON COLUMN admin.audit_logs.request_id IS
  '文本后处理专用 RPC 的幂等键。相同 id 且摘要一致返回原结果；其他审计动作为 NULL。';
COMMENT ON COLUMN admin.audit_logs.request_digest IS
  '与 request_id 配对的内容摘要。相同 id、不同摘要视为冲突，不覆盖已提交结果。';

DO $digest_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'admin.config_drafts'::regclass
      AND conname = 'config_drafts_content_digest_check'
  ) THEN
    ALTER TABLE admin.config_drafts
      ADD CONSTRAINT config_drafts_content_digest_check
      CHECK (content_digest IS NULL OR content_digest ~ '^[a-f0-9]{64}$');
  END IF;
END
$digest_check$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_audit_logs_request_id
  ON admin.audit_logs (request_id)
  WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_core.text_postprocess_versions (
  version integer PRIMARY KEY,
  source jsonb NOT NULL,
  schema_version integer NOT NULL,
  policy_version integer NOT NULL,
  published_at timestamptz NOT NULL,
  CONSTRAINT text_postprocess_versions_version_check CHECK (version > 0),
  CONSTRAINT text_postprocess_versions_schema_version_check CHECK (schema_version > 0),
  CONSTRAINT text_postprocess_versions_policy_version_check CHECK (policy_version > 0),
  CONSTRAINT text_postprocess_versions_source_object_check CHECK (jsonb_typeof(source) = 'object')
);

-- 早期本地草案可能已有 NULL 历史行：不回填，不验证旧行，但新 INSERT/UPDATE 必须满足 CHECK。
ALTER TABLE app_core.text_postprocess_versions ADD COLUMN IF NOT EXISTS artifact jsonb;
DO $artifact_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'app_core.text_postprocess_versions'::regclass AND conname = 'text_postprocess_versions_artifact_check') THEN
    ALTER TABLE app_core.text_postprocess_versions ADD CONSTRAINT text_postprocess_versions_artifact_check
      CHECK (artifact IS NOT NULL AND jsonb_typeof(artifact) = 'object'
        AND artifact ? 'schema_version' AND artifact ? 'policy_version' AND artifact ? 'rules'
        AND artifact -> 'schema_version' = to_jsonb(schema_version)
        AND artifact -> 'policy_version' = to_jsonb(policy_version)
        AND schema_version = 1 AND policy_version = 1
        AND jsonb_typeof(artifact -> 'rules') = 'array') NOT VALID;
  END IF;
END
$artifact_check$;
COMMENT ON COLUMN app_core.text_postprocess_versions.artifact IS
  'Backend Worker 编译并再校验的不可变 artifact。旧 NULL 行保留且不可用；不得读时编译或回填。';

-- 删除早期草案签名，不能保留不要求 artifact 的重载。
DROP FUNCTION IF EXISTS admin.publish_text_postprocess(uuid, uuid, text, integer, timestamptz, text, text);
DROP FUNCTION IF EXISTS admin.rollback_text_postprocess(uuid, uuid, text, integer, integer);
DROP FUNCTION IF EXISTS admin.text_postprocess_commit_release(admin.admin_users, jsonb, integer, timestamptz, uuid, uuid, uuid, text, text, jsonb);

COMMENT ON TABLE app_core.text_postprocess_versions IS
  '已发布 AI 回复后处理规则的不可变快照。只插入；历史消息可引用任意旧版本。';
COMMENT ON COLUMN app_core.text_postprocess_versions.version IS
  '发布版本，正整数。与 runtime_config.miniapp_text_postprocess_config 的当前 version 对齐，不单独发号。';
COMMENT ON COLUMN app_core.text_postprocess_versions.source IS
  '规则 source。含 schema_version、policy_version 和 rules，不含草稿、测试文本或操作者。';
COMMENT ON COLUMN app_core.text_postprocess_versions.schema_version IS
  '快照形状版本，不等于发布序号。';
COMMENT ON COLUMN app_core.text_postprocess_versions.policy_version IS
  '安全策略版本。运行时可以拒绝不再支持的策略，但不能据此改写本行。';
COMMENT ON COLUMN app_core.text_postprocess_versions.published_at IS
  '该快照发布时刻。回滚会新建一行，不修改被回滚的这一行。';

ALTER TABLE app_core.text_postprocess_versions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE app_core.text_postprocess_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE app_core.text_postprocess_versions TO service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE app_core.text_postprocess_versions FROM service_role, postgres;
GRANT SELECT ON TABLE app_core.text_postprocess_versions TO postgres;

-- 专用 RPC 进入写保护：当前用户必须是函数属主，且本事务建了守卫临时表。
-- service_role 即使自行建临时表也过不了属主检查；通用 SECURITY DEFINER 发布函数
-- 属主相同，但不会建守卫表，因此不能改这个 key。
CREATE OR REPLACE FUNCTION admin.text_postprocess_writer_enter()
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS text_postprocess_writer_guard (
    id integer PRIMARY KEY
  ) ON COMMIT DROP;
  INSERT INTO pg_temp.text_postprocess_writer_guard (id)
  VALUES (1)
  ON CONFLICT (id) DO NOTHING;
END;
$fn$;

CREATE OR REPLACE FUNCTION admin.text_postprocess_writer_ok()
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(p.proowner)
    INTO v_owner
  FROM pg_catalog.pg_proc AS p
  WHERE p.oid = 'admin.text_postprocess_writer_enter()'::regprocedure;

  RETURN current_user IS NOT DISTINCT FROM v_owner
    AND to_regclass('pg_temp.text_postprocess_writer_guard') IS NOT NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION admin.reject_generic_text_postprocess_write(p_config_key text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF p_config_key = 'miniapp_text_postprocess_config' THEN
    RAISE EXCEPTION 'forbidden: miniapp_text_postprocess_config requires the dedicated text-postprocess RPC'
      USING ERRCODE = '42501';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION admin.guard_text_postprocess_config_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_new_key text;
  v_old_key text;
  v_touched boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'runtime_config' THEN
    IF TG_OP <> 'INSERT' THEN
      v_old_key := OLD.key;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      v_new_key := NEW.key;
    END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN
      v_old_key := OLD.config_key;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      v_new_key := NEW.config_key;
    END IF;
  END IF;

  v_touched := v_new_key = 'miniapp_text_postprocess_config'
    OR v_old_key = 'miniapp_text_postprocess_config';
  IF NOT v_touched THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF NOT admin.text_postprocess_writer_ok() THEN
    RAISE EXCEPTION 'forbidden: miniapp_text_postprocess_config requires the dedicated text-postprocess RPC'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION admin.guard_text_postprocess_audit_request()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_request uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_request := OLD.request_id;
  ELSIF TG_OP = 'UPDATE' THEN
    v_request := COALESCE(NEW.request_id, OLD.request_id);
  ELSE
    v_request := NEW.request_id;
  END IF;

  IF v_request IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF NOT admin.text_postprocess_writer_ok() THEN
    RAISE EXCEPTION 'forbidden: text-postprocess request audit requires the dedicated RPC'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION app_core.guard_text_postprocess_version_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'text_postprocess_versions are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NOT admin.text_postprocess_writer_ok() THEN
    RAISE EXCEPTION 'forbidden: text_postprocess_versions are written only by the dedicated RPC'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_guard_text_postprocess_runtime_config ON app_core.runtime_config;
CREATE TRIGGER trg_guard_text_postprocess_runtime_config
  BEFORE INSERT OR UPDATE OR DELETE ON app_core.runtime_config
  FOR EACH ROW
  EXECUTE FUNCTION admin.guard_text_postprocess_config_write();

DROP TRIGGER IF EXISTS trg_guard_text_postprocess_config_drafts ON admin.config_drafts;
CREATE TRIGGER trg_guard_text_postprocess_config_drafts
  BEFORE INSERT OR UPDATE OR DELETE ON admin.config_drafts
  FOR EACH ROW
  EXECUTE FUNCTION admin.guard_text_postprocess_config_write();

DROP TRIGGER IF EXISTS trg_guard_text_postprocess_config_releases ON admin.config_releases;
CREATE TRIGGER trg_guard_text_postprocess_config_releases
  BEFORE INSERT OR UPDATE OR DELETE ON admin.config_releases
  FOR EACH ROW
  EXECUTE FUNCTION admin.guard_text_postprocess_config_write();

DROP TRIGGER IF EXISTS trg_guard_text_postprocess_audit_request ON admin.audit_logs;
CREATE TRIGGER trg_guard_text_postprocess_audit_request
  BEFORE INSERT OR UPDATE OR DELETE ON admin.audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION admin.guard_text_postprocess_audit_request();

DROP TRIGGER IF EXISTS trg_text_postprocess_versions_immutable ON app_core.text_postprocess_versions;
CREATE TRIGGER trg_text_postprocess_versions_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON app_core.text_postprocess_versions
  FOR EACH ROW
  EXECUTE FUNCTION app_core.guard_text_postprocess_version_write();

-- TRUNCATE 不触发行级 trigger；同样拒绝 owner/postgres 的批量清空。
DROP TRIGGER IF EXISTS trg_text_postprocess_versions_no_truncate ON app_core.text_postprocess_versions;
CREATE TRIGGER trg_text_postprocess_versions_no_truncate
  BEFORE TRUNCATE ON app_core.text_postprocess_versions
  FOR EACH STATEMENT
  EXECUTE FUNCTION app_core.guard_text_postprocess_version_write();

-- 结构与容量只对齐 shared TEXT_POSTPROCESS_LIMITS / draft|source schema。
-- HTML/CSS/正则诊断仍由 Backend 在调用前完成；这里不能代替 AST。
CREATE OR REPLACE FUNCTION admin.validate_text_postprocess_source(
  p_source jsonb,
  p_mode text
) RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_rule jsonb;
  v_key text;
  v_id text;
  v_flags text;
  v_seen text[] := ARRAY[]::text[];
  v_flag_index integer;
  v_schema integer;
  v_policy integer;
  v_prefix text;
BEGIN
  IF p_mode NOT IN ('draft', 'publish', 'rollback') THEN
    RAISE EXCEPTION 'invalid_source: unsupported validation mode'
      USING ERRCODE = '22023';
  END IF;
  v_prefix := CASE WHEN p_mode = 'draft' THEN 'invalid_draft' ELSE 'invalid_source' END;

  IF p_source IS NULL OR jsonb_typeof(p_source) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION '%: source must be an object', v_prefix USING ERRCODE = '22023';
  END IF;
  IF octet_length(convert_to(p_source::text, 'UTF8')) > 262144 THEN
    RAISE EXCEPTION '%: source exceeds 256 KiB', v_prefix USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_source) AS key
    WHERE key NOT IN ('schema_version', 'policy_version', 'rules')
  ) THEN
    RAISE EXCEPTION '%: unknown source field', v_prefix USING ERRCODE = '22023';
  END IF;
  IF (p_source ->> 'schema_version') !~ '^[0-9]+$'
     OR (p_source ->> 'policy_version') !~ '^[0-9]+$'
     OR jsonb_typeof(p_source -> 'rules') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION '%: source shape is invalid', v_prefix USING ERRCODE = '22023';
  END IF;

  v_schema := (p_source ->> 'schema_version')::integer;
  v_policy := (p_source ->> 'policy_version')::integer;
  IF v_schema <> 1 THEN
    RAISE EXCEPTION '%: unsupported schema_version', v_prefix USING ERRCODE = '22023';
  END IF;
  IF v_policy <> 1 THEN
    IF p_mode = 'rollback' THEN
      RAISE EXCEPTION 'policy_unsupported: snapshot policy_version is not supported'
        USING ERRCODE = '22023';
    END IF;
    RAISE EXCEPTION '%: unsupported policy_version', v_prefix USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_source -> 'rules') > 100 THEN
    RAISE EXCEPTION '%: too many rules', v_prefix USING ERRCODE = '22023';
  END IF;

  FOR v_rule IN
    SELECT value
    FROM jsonb_array_elements(p_source -> 'rules') AS rule(value)
  LOOP
    IF jsonb_typeof(v_rule) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION '%: rule must be an object', v_prefix USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM jsonb_object_keys(v_rule) AS key
      WHERE key NOT IN (
        'id', 'name', 'description', 'enabled', 'pattern', 'flags', 'replacement', 'css', 'notes'
      )
    ) OR NOT (
      v_rule ? 'id' AND v_rule ? 'name' AND v_rule ? 'description' AND v_rule ? 'enabled'
      AND v_rule ? 'pattern' AND v_rule ? 'flags' AND v_rule ? 'replacement'
      AND v_rule ? 'css' AND v_rule ? 'notes'
    ) THEN
      RAISE EXCEPTION '%: rule fields are invalid', v_prefix USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_rule -> 'enabled') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(v_rule -> 'id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_rule -> 'name') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_rule -> 'description') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_rule -> 'pattern') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_rule -> 'flags') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_rule -> 'replacement') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_rule -> 'css') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_rule -> 'notes') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION '%: rule field types are invalid', v_prefix USING ERRCODE = '22023';
    END IF;

    v_id := v_rule ->> 'id';
    IF v_id !~ '^[a-z][a-z0-9_-]{0,63}$' OR v_id = ANY (v_seen) THEN
      RAISE EXCEPTION '%: rule id is invalid or duplicated', v_prefix USING ERRCODE = '22023';
    END IF;
    v_seen := array_append(v_seen, v_id);

    IF char_length(v_rule ->> 'name') NOT BETWEEN 1 AND 80
       OR btrim(v_rule ->> 'name') = ''
       OR char_length(v_rule ->> 'description') > 400
       OR char_length(v_rule ->> 'pattern') NOT BETWEEN 1 AND 2000
       OR char_length(v_rule ->> 'flags') > 8
       OR char_length(v_rule ->> 'replacement') > 16000
       OR char_length(v_rule ->> 'css') > 16000
       OR char_length(v_rule ->> 'notes') > 2000 THEN
      RAISE EXCEPTION '%: rule field length is invalid', v_prefix USING ERRCODE = '22023';
    END IF;

    IF p_mode IN ('publish', 'rollback') THEN
      v_flags := v_rule ->> 'flags';
      IF v_flags !~ '^[gimsu]*$' THEN
        RAISE EXCEPTION '%: flags are not supported', v_prefix USING ERRCODE = '22023';
      END IF;
      FOR v_flag_index IN 1..char_length(v_flags) LOOP
        v_key := substr(v_flags, v_flag_index, 1);
        IF strpos(left(v_flags, v_flag_index - 1), v_key) > 0 THEN
          RAISE EXCEPTION '%: flags are duplicated', v_prefix USING ERRCODE = '22023';
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END;
$fn$;

-- 这里只验证协议、基本 shape 和 source 规则身份；不在 SQL 复制 JavaScript 编译器。
CREATE OR REPLACE FUNCTION admin.validate_text_postprocess_artifact(p_source jsonb, p_artifact jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  v_source_rule jsonb;
  v_rule jsonb;
  v_index integer;
BEGIN
  IF p_artifact IS NULL OR jsonb_typeof(p_artifact) IS DISTINCT FROM 'object'
    OR p_artifact -> 'schema_version' IS DISTINCT FROM p_source -> 'schema_version'
    OR p_artifact -> 'policy_version' IS DISTINCT FROM p_source -> 'policy_version'
    OR jsonb_typeof(p_artifact -> 'rules') IS DISTINCT FROM 'array'
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_artifact) AS key WHERE key NOT IN ('schema_version','policy_version','rules')) THEN
    RAISE EXCEPTION 'invalid_source: compiled artifact is required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_artifact -> 'rules') <> jsonb_array_length(p_source -> 'rules') THEN
    RAISE EXCEPTION 'invalid_source: artifact source rule count mismatch' USING ERRCODE = '22023';
  END IF;
  FOR v_index IN 0..jsonb_array_length(p_source -> 'rules') - 1 LOOP
    v_source_rule := p_source -> 'rules' -> v_index;
    v_rule := p_artifact -> 'rules' -> v_index;
    IF jsonb_typeof(v_rule) IS DISTINCT FROM 'object'
      OR v_rule -> 'id' IS DISTINCT FROM v_source_rule -> 'id'
      OR v_rule -> 'enabled' IS DISTINCT FROM v_source_rule -> 'enabled'
      OR v_rule -> 'pattern' IS DISTINCT FROM v_source_rule -> 'pattern'
      OR v_rule -> 'flags' IS DISTINCT FROM v_source_rule -> 'flags'
      OR jsonb_typeof(v_rule -> 'groups') IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_rule -> 'tree') IS DISTINCT FROM 'array'
      OR jsonb_array_length(v_rule -> 'tree') < 1
      OR jsonb_typeof(v_rule -> 'css') IS DISTINCT FROM 'array'
      OR COALESCE(v_rule ->> 'placement', '') NOT IN ('inline','block') THEN
      RAISE EXCEPTION 'invalid_source: artifact source binding mismatch' USING ERRCODE = '22023';
    END IF;
  END LOOP;
END;
$fn$;

CREATE OR REPLACE FUNCTION admin.text_postprocess_require_actor(
  p_actor_user_id uuid,
  p_allow_viewer boolean
) RETURNS admin.admin_users
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_environment text;
BEGIN
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'forbidden: actor is required' USING ERRCODE = '42501';
  END IF;

  SELECT au.*
    INTO v_actor
  FROM admin.admin_users AS au
  WHERE au.user_id = p_actor_user_id;

  IF NOT FOUND
     OR (
       p_allow_viewer AND v_actor.role NOT IN ('owner', 'operator', 'viewer')
     )
     OR (
       NOT p_allow_viewer AND v_actor.role NOT IN ('owner', 'operator')
     ) THEN
    RAISE EXCEPTION 'forbidden: operator access required' USING ERRCODE = '42501';
  END IF;

  v_environment := admin.current_environment();
  IF (v_environment = 'test' AND NOT v_actor.can_access_test)
     OR (v_environment = 'production' AND NOT v_actor.can_access_prod) THEN
    RAISE EXCEPTION 'forbidden: environment access denied' USING ERRCODE = '42501';
  END IF;

  RETURN v_actor;
END;
$fn$;

-- 返回已提交结果（replayed=true），没有记录时返回 NULL。冲突直接抛出。
-- 调用方在写入前持有 request_id 事务锁；锁会保持到外层事务结束。
CREATE OR REPLACE FUNCTION admin.text_postprocess_begin_request(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_request_digest text,
  p_allow_viewer boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_environment text;
  v_digest text;
  v_outcome jsonb;
BEGIN
  PERFORM admin.text_postprocess_require_actor(p_actor_user_id, p_allow_viewer);

  IF p_request_id IS NULL OR p_request_digest !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid_source: request_id and request_digest are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('text-postprocess-request:' || p_request_id::text, 0)
  );

  v_environment := admin.current_environment();
  SELECT audit_log.request_digest, audit_log.after_value -> 'outcome'
    INTO v_digest, v_outcome
  FROM admin.audit_logs AS audit_log
  WHERE audit_log.request_id = p_request_id
    AND audit_log.environment = v_environment;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_digest IS DISTINCT FROM p_request_digest OR v_outcome IS NULL THEN
    RAISE EXCEPTION 'request_id_conflict: request_id was already used with different content'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN v_outcome || jsonb_build_object('replayed', true);
END;
$fn$;

CREATE OR REPLACE FUNCTION admin.text_postprocess_record_request(
  p_actor admin.admin_users,
  p_action text,
  p_request_id uuid,
  p_request_digest text,
  p_before jsonb,
  p_outcome jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_environment text;
  v_stored jsonb;
BEGIN
  v_environment := admin.current_environment();
  v_stored := p_outcome || jsonb_build_object('replayed', false);
  INSERT INTO admin.audit_logs (
    actor_user_id,
    actor_email,
    environment,
    action,
    schema_name,
    table_name,
    record_id,
    before_value,
    after_value,
    request_id,
    request_digest
  ) VALUES (
    p_actor.user_id,
    p_actor.email,
    v_environment,
    p_action,
    'app_core',
    'text_postprocess_versions',
    COALESCE(v_stored ->> 'version', v_stored ->> 'draft_id', p_request_id::text),
    p_before,
    jsonb_build_object('outcome', v_stored),
    p_request_id,
    p_request_digest
  );
  RETURN v_stored;
END;
$fn$;

CREATE OR REPLACE FUNCTION admin.text_postprocess_lock_runtime()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_version integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'admin.runtime_config:miniapp_text_postprocess_config',
      0
    )
  );

  SELECT rc.version
    INTO v_version
  FROM app_core.runtime_config AS rc
  WHERE rc.key = 'miniapp_text_postprocess_config'
  FOR UPDATE;

  IF FOUND AND (v_version IS NULL OR v_version <= 0) THEN
    RAISE EXCEPTION 'text postprocess runtime version is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN v_version;
END;
$fn$;

CREATE OR REPLACE FUNCTION admin.text_postprocess_commit_release(
  p_actor admin.admin_users,
  p_source jsonb,
  p_artifact jsonb,
  p_version integer,
  p_published_at timestamptz,
  p_draft_id uuid,
  p_rollback_of uuid,
  p_request_id uuid,
  p_request_digest text,
  p_action text,
  p_outcome jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_environment text;
  v_schema integer;
  v_policy integer;
  v_value jsonb;
  v_release_id uuid;
  v_written integer;
BEGIN
  v_environment := admin.current_environment();
  v_schema := (p_source ->> 'schema_version')::integer;
  v_policy := (p_source ->> 'policy_version')::integer;
  v_value := jsonb_build_object(
    'version', p_version,
    'schema_version', v_schema,
    'policy_version', v_policy,
    'source', p_source,
    'published_at', p_published_at
  );

  INSERT INTO app_core.text_postprocess_versions (
    version, source, artifact, schema_version, policy_version, published_at
  ) VALUES (
    p_version, p_source, p_artifact, v_schema, v_policy, p_published_at
  );

  INSERT INTO app_core.runtime_config AS rc (
    key, value, description, version, updated_at, text_value
  ) VALUES (
    'miniapp_text_postprocess_config',
    v_value,
    '已发布的 AI 回复展示规则。历史消息读取 text_postprocess_versions，不跟随后续发布。',
    p_version,
    p_published_at,
    NULL
  )
  ON CONFLICT (key) DO UPDATE SET
    value = EXCLUDED.value,
    description = EXCLUDED.description,
    version = EXCLUDED.version,
    updated_at = EXCLUDED.updated_at,
    text_value = NULL
  WHERE rc.version IS NOT DISTINCT FROM (p_version - 1)
     OR (p_version = 1 AND rc.version IS NULL)
  RETURNING rc.version INTO v_written;

  IF v_written IS DISTINCT FROM p_version THEN
    RAISE EXCEPTION 'cas_conflict: runtime version changed'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO admin.config_releases (
    environment,
    config_key,
    runtime_version,
    value,
    text_value,
    description,
    source_draft_id,
    rollback_of_release_id,
    released_by,
    released_at
  ) VALUES (
    v_environment,
    'miniapp_text_postprocess_config',
    p_version,
    v_value,
    NULL,
    '已发布的 AI 回复展示规则。历史消息读取 text_postprocess_versions，不跟随后续发布。',
    p_draft_id,
    p_rollback_of,
    p_actor.user_id,
    p_published_at
  )
  RETURNING id INTO v_release_id;

  RETURN admin.text_postprocess_record_request(
    p_actor,
    p_action,
    p_request_id,
    p_request_digest,
    NULL,
    p_outcome || jsonb_build_object('release_id', v_release_id, 'published_at', p_published_at)
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION admin.save_text_postprocess_draft(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_request_digest text,
  p_expected_runtime_version integer,
  p_expected_draft_updated_at timestamptz,
  p_expected_draft_digest text,
  p_content_digest text,
  p_source jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_replay jsonb;
  v_environment text;
  v_runtime_version integer;
  v_draft admin.config_drafts%ROWTYPE;
  v_before jsonb;
  v_now timestamptz;
  v_outcome jsonb;
BEGIN
  v_replay := admin.text_postprocess_begin_request(
    p_actor_user_id, p_request_id, p_request_digest, false
  );
  IF v_replay IS NOT NULL THEN
    RETURN v_replay;
  END IF;

  IF p_content_digest !~ '^[a-f0-9]{64}$'
     OR (
       p_expected_draft_digest IS NOT NULL
       AND p_expected_draft_digest !~ '^[a-f0-9]{64}$'
     ) THEN
    RAISE EXCEPTION 'invalid_draft: digest must be 64 lowercase hex characters'
      USING ERRCODE = '22023';
  END IF;
  PERFORM admin.validate_text_postprocess_source(p_source, 'draft');

  v_actor := admin.text_postprocess_require_actor(p_actor_user_id, false);
  PERFORM admin.text_postprocess_writer_enter();
  v_environment := admin.current_environment();
  v_runtime_version := admin.text_postprocess_lock_runtime();
  IF p_expected_runtime_version IS DISTINCT FROM v_runtime_version THEN
    RAISE EXCEPTION 'cas_conflict: runtime version changed' USING ERRCODE = '40001';
  END IF;

  SELECT draft.*
    INTO v_draft
  FROM admin.config_drafts AS draft
  WHERE draft.environment = v_environment
    AND draft.config_key = 'miniapp_text_postprocess_config'
    AND draft.status = 'draft'
  FOR UPDATE;

  IF FOUND THEN
    IF p_expected_draft_updated_at IS NULL
       OR p_expected_draft_digest IS NULL
       OR date_trunc('milliseconds', v_draft.updated_at)
          IS DISTINCT FROM date_trunc('milliseconds', p_expected_draft_updated_at)
       OR v_draft.content_digest IS DISTINCT FROM p_expected_draft_digest THEN
      RAISE EXCEPTION 'cas_conflict: draft changed' USING ERRCODE = '40001';
    END IF;
    v_before := jsonb_build_object(
      'draft_id', v_draft.id,
      'content_digest', v_draft.content_digest,
      'updated_at', v_draft.updated_at
    );
    v_now := pg_catalog.clock_timestamp();
    UPDATE admin.config_drafts
    SET value = p_source,
        text_value = NULL,
        content_digest = p_content_digest,
        base_version = COALESCE(v_runtime_version, 0),
        updated_by = v_actor.user_id,
        updated_at = v_now
    WHERE id = v_draft.id
    RETURNING * INTO v_draft;
  ELSE
    IF p_expected_draft_updated_at IS NOT NULL OR p_expected_draft_digest IS NOT NULL THEN
      RAISE EXCEPTION 'cas_conflict: draft changed' USING ERRCODE = '40001';
    END IF;
    v_now := pg_catalog.clock_timestamp();
    INSERT INTO admin.config_drafts (
      environment, config_key, value, text_value, description, base_version,
      content_digest, status, created_by, updated_by, created_at, updated_at
    ) VALUES (
      v_environment,
      'miniapp_text_postprocess_config',
      p_source,
      NULL,
      'AI 回复后处理草稿。未发布前不影响线上。',
      COALESCE(v_runtime_version, 0),
      p_content_digest,
      'draft',
      v_actor.user_id,
      v_actor.user_id,
      v_now,
      v_now
    )
    RETURNING * INTO v_draft;
  END IF;

  v_outcome := jsonb_build_object(
    'action', 'save',
    'draft_id', v_draft.id,
    'draft_revision', v_draft.id::text,
    'updated_at', v_draft.updated_at,
    'content_digest', v_draft.content_digest,
    'base_version', v_draft.base_version,
    'runtime_version', v_runtime_version
  );
  RETURN admin.text_postprocess_record_request(
    v_actor,
    'text_postprocess.draft.save',
    p_request_id,
    p_request_digest,
    v_before,
    v_outcome
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION admin.publish_text_postprocess(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_request_digest text,
  p_expected_runtime_version integer,
  p_expected_draft_updated_at timestamptz,
  p_expected_draft_digest text,
  p_draft_revision text,
  p_source jsonb,
  p_artifact jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_replay jsonb;
  v_request_digest text;
  v_environment text;
  v_runtime_version integer;
  v_max_version integer;
  v_next integer;
  v_draft admin.config_drafts%ROWTYPE;
  v_published_at timestamptz;
BEGIN
  -- 数据库绑定实际 payload，不能只信任调用方提供的摘要。
  v_request_digest := encode(sha256(convert_to(jsonb_build_object('action','publish','actor',p_actor_user_id,'digest',p_request_digest,'expected_runtime_version',p_expected_runtime_version,'updated_at',p_expected_draft_updated_at,'draft_digest',p_expected_draft_digest,'revision',p_draft_revision,'source',p_source,'artifact',p_artifact)::text, 'UTF8')), 'hex');
  v_replay := admin.text_postprocess_begin_request(
    p_actor_user_id, p_request_id, v_request_digest, false
  );
  IF v_replay IS NOT NULL THEN
    RETURN v_replay;
  END IF;
  IF p_expected_draft_updated_at IS NULL
     OR p_expected_draft_digest !~ '^[a-f0-9]{64}$'
     OR p_draft_revision IS NULL
     OR char_length(p_draft_revision) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid_source: publish preconditions are incomplete'
      USING ERRCODE = '22023';
  END IF;

  v_actor := admin.text_postprocess_require_actor(p_actor_user_id, false);
  PERFORM admin.text_postprocess_writer_enter();
  v_environment := admin.current_environment();
  v_runtime_version := admin.text_postprocess_lock_runtime();
  IF p_expected_runtime_version IS DISTINCT FROM v_runtime_version THEN
    RAISE EXCEPTION 'cas_conflict: runtime version changed' USING ERRCODE = '40001';
  END IF;

  SELECT COALESCE(max(version), 0)
    INTO v_max_version
  FROM app_core.text_postprocess_versions;
  IF v_max_version IS DISTINCT FROM COALESCE(v_runtime_version, 0) THEN
    RAISE EXCEPTION 'text postprocess version invariant broken'
      USING ERRCODE = '55000';
  END IF;
  v_next := COALESCE(v_runtime_version, 0) + 1;

  SELECT draft.*
    INTO v_draft
  FROM admin.config_drafts AS draft
  WHERE draft.environment = v_environment
    AND draft.config_key = 'miniapp_text_postprocess_config'
    AND draft.status = 'draft'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_draft: active draft not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_draft.id::text IS DISTINCT FROM p_draft_revision THEN
    RAISE EXCEPTION 'draft_revision_mismatch: publish target is not the saved draft'
      USING ERRCODE = '22023';
  END IF;
  IF v_draft.base_version IS DISTINCT FROM COALESCE(v_runtime_version, 0)
     OR v_draft.content_digest IS DISTINCT FROM p_expected_draft_digest
     OR date_trunc('milliseconds', v_draft.updated_at)
        IS DISTINCT FROM date_trunc('milliseconds', p_expected_draft_updated_at) THEN
    RAISE EXCEPTION 'cas_conflict: draft changed' USING ERRCODE = '40001';
  END IF;

  IF v_draft.value IS DISTINCT FROM p_source THEN
    RAISE EXCEPTION 'cas_conflict: compiled source differs from draft' USING ERRCODE = '40001';
  END IF;
  PERFORM admin.validate_text_postprocess_source(v_draft.value, 'publish');
  PERFORM admin.validate_text_postprocess_artifact(p_source, p_artifact);
  v_published_at := pg_catalog.clock_timestamp();
  UPDATE admin.config_drafts
  SET status = 'published',
      updated_by = v_actor.user_id,
      updated_at = v_published_at,
      published_at = v_published_at
  WHERE id = v_draft.id;

  RETURN admin.text_postprocess_commit_release(
    v_actor,
    v_draft.value,
    p_artifact,
    v_next,
    v_published_at,
    v_draft.id,
    NULL,
    p_request_id,
    v_request_digest,
    'text_postprocess.publish',
    jsonb_build_object(
      'action', 'publish',
      'version', v_next,
      'schema_version', (v_draft.value ->> 'schema_version')::integer,
      'policy_version', (v_draft.value ->> 'policy_version')::integer,
      'runtime_version', v_next,
      'draft_id', v_draft.id
    )
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION admin.rollback_text_postprocess(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_request_digest text,
  p_expected_runtime_version integer,
  p_target_version integer,
  p_source jsonb,
  p_artifact jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_replay jsonb;
  v_request_digest text;
  v_environment text;
  v_runtime_version integer;
  v_max_version integer;
  v_next integer;
  v_source jsonb;
  v_target_release uuid;
  v_published_at timestamptz;
BEGIN
  -- 数据库绑定实际 payload，不能只信任调用方提供的摘要。
  v_request_digest := encode(sha256(convert_to(jsonb_build_object('action','rollback','actor',p_actor_user_id,'digest',p_request_digest,'expected_runtime_version',p_expected_runtime_version,'target_version',p_target_version,'source',p_source,'artifact',p_artifact)::text, 'UTF8')), 'hex');
  v_replay := admin.text_postprocess_begin_request(
    p_actor_user_id, p_request_id, v_request_digest, false
  );
  IF v_replay IS NOT NULL THEN
    RETURN v_replay;
  END IF;
  IF p_expected_runtime_version IS NULL OR p_expected_runtime_version <= 0
     OR p_target_version IS NULL OR p_target_version <= 0 THEN
    RAISE EXCEPTION 'invalid_source: rollback versions must be positive'
      USING ERRCODE = '22023';
  END IF;

  v_actor := admin.text_postprocess_require_actor(p_actor_user_id, false);
  PERFORM admin.text_postprocess_writer_enter();
  v_environment := admin.current_environment();
  v_runtime_version := admin.text_postprocess_lock_runtime();
  IF p_expected_runtime_version IS DISTINCT FROM v_runtime_version THEN
    RAISE EXCEPTION 'cas_conflict: runtime version changed' USING ERRCODE = '40001';
  END IF;

  SELECT snapshot.source
    INTO v_source
  FROM app_core.text_postprocess_versions AS snapshot
  WHERE snapshot.version = p_target_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target_version_unavailable: published snapshot was not found'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_source IS DISTINCT FROM p_source THEN
    RAISE EXCEPTION 'cas_conflict: compiled source differs from target' USING ERRCODE = '40001';
  END IF;
  PERFORM admin.validate_text_postprocess_source(v_source, 'rollback');

  SELECT release.id
    INTO v_target_release
  FROM admin.config_releases AS release
  WHERE release.environment = v_environment
    AND release.config_key = 'miniapp_text_postprocess_config'
    AND release.runtime_version = p_target_version;
  IF v_target_release IS NULL THEN
    RAISE EXCEPTION 'text postprocess release link is missing for version %', p_target_version
      USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(max(version), 0)
    INTO v_max_version
  FROM app_core.text_postprocess_versions;
  IF v_max_version IS DISTINCT FROM COALESCE(v_runtime_version, 0) THEN
    RAISE EXCEPTION 'text postprocess version invariant broken'
      USING ERRCODE = '55000';
  END IF;
  v_next := v_runtime_version + 1;
  PERFORM admin.validate_text_postprocess_artifact(p_source, p_artifact);
  v_published_at := pg_catalog.clock_timestamp();

  RETURN admin.text_postprocess_commit_release(
    v_actor,
    v_source,
    p_artifact,
    v_next,
    v_published_at,
    NULL,
    v_target_release,
    p_request_id,
    v_request_digest,
    'text_postprocess.rollback',
    jsonb_build_object(
      'action', 'rollback',
      'version', v_next,
      'schema_version', (v_source ->> 'schema_version')::integer,
      'policy_version', (v_source ->> 'policy_version')::integer,
      'runtime_version', v_next,
      'target_version', p_target_version,
      'rollback_of_release_id', v_target_release
    )
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION admin.discard_text_postprocess_draft(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_request_digest text,
  p_expected_draft_updated_at timestamptz,
  p_expected_draft_digest text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_replay jsonb;
  v_environment text;
  v_draft admin.config_drafts%ROWTYPE;
BEGIN
  v_replay := admin.text_postprocess_begin_request(
    p_actor_user_id, p_request_id, p_request_digest, false
  );
  IF v_replay IS NOT NULL THEN
    RETURN v_replay;
  END IF;
  IF p_expected_draft_updated_at IS NULL
     OR p_expected_draft_digest !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid_draft: discard preconditions are incomplete'
      USING ERRCODE = '22023';
  END IF;

  v_actor := admin.text_postprocess_require_actor(p_actor_user_id, false);
  PERFORM admin.text_postprocess_writer_enter();
  PERFORM admin.text_postprocess_lock_runtime();
  v_environment := admin.current_environment();

  SELECT draft.*
    INTO v_draft
  FROM admin.config_drafts AS draft
  WHERE draft.environment = v_environment
    AND draft.config_key = 'miniapp_text_postprocess_config'
    AND draft.status = 'draft'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_draft: active draft not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_draft.content_digest IS DISTINCT FROM p_expected_draft_digest
     OR date_trunc('milliseconds', v_draft.updated_at)
        IS DISTINCT FROM date_trunc('milliseconds', p_expected_draft_updated_at) THEN
    RAISE EXCEPTION 'cas_conflict: draft changed' USING ERRCODE = '40001';
  END IF;

  DELETE FROM admin.config_drafts
  WHERE id = v_draft.id;

  RETURN admin.text_postprocess_record_request(
    v_actor,
    'text_postprocess.draft.discard',
    p_request_id,
    p_request_digest,
    jsonb_build_object(
      'draft_id', v_draft.id,
      'content_digest', v_draft.content_digest,
      'updated_at', v_draft.updated_at
    ),
    jsonb_build_object('action', 'discard', 'draft_id', v_draft.id)
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION admin.get_text_postprocess_request(
  p_actor_user_id uuid,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_environment text;
  v_outcome jsonb;
BEGIN
  PERFORM admin.text_postprocess_require_actor(p_actor_user_id, true);
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'invalid_source: request_id is required' USING ERRCODE = '22023';
  END IF;

  v_environment := admin.current_environment();
  SELECT audit_log.after_value -> 'outcome'
    INTO v_outcome
  FROM admin.audit_logs AS audit_log
  WHERE audit_log.request_id = p_request_id
    AND audit_log.environment = v_environment;

  RETURN v_outcome;
END;
$fn$;

REVOKE ALL ON FUNCTION admin.text_postprocess_writer_enter() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.text_postprocess_writer_ok() FROM PUBLIC, anon, authenticated, service_role;
-- 触发器以写入者身份调用判断函数。判断本身不打开写保护。
GRANT EXECUTE ON FUNCTION admin.text_postprocess_writer_ok() TO anon, authenticated, service_role, postgres;
REVOKE ALL ON FUNCTION admin.reject_generic_text_postprocess_write(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.guard_text_postprocess_config_write() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.guard_text_postprocess_audit_request() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_core.guard_text_postprocess_version_write() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_text_postprocess_artifact(jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_text_postprocess_source(jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.text_postprocess_require_actor(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.text_postprocess_begin_request(uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.text_postprocess_record_request(admin.admin_users, text, uuid, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.text_postprocess_lock_runtime() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.text_postprocess_commit_release(admin.admin_users, jsonb, jsonb, integer, timestamptz, uuid, uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION admin.save_text_postprocess_draft(uuid, uuid, text, integer, timestamptz, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION admin.publish_text_postprocess(uuid, uuid, text, integer, timestamptz, text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION admin.rollback_text_postprocess(uuid, uuid, text, integer, integer, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION admin.discard_text_postprocess_draft(uuid, uuid, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION admin.get_text_postprocess_request(uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION admin.save_text_postprocess_draft(uuid, uuid, text, integer, timestamptz, text, text, jsonb) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.publish_text_postprocess(uuid, uuid, text, integer, timestamptz, text, text, jsonb, jsonb) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.rollback_text_postprocess(uuid, uuid, text, integer, integer, jsonb, jsonb) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.discard_text_postprocess_draft(uuid, uuid, text, timestamptz, text) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.get_text_postprocess_request(uuid, uuid) TO service_role, postgres;

COMMENT ON FUNCTION admin.save_text_postprocess_draft(uuid, uuid, text, integer, timestamptz, text, text, jsonb) IS
  '保存文本后处理草稿。不写 runtime_config 或版本快照。request_id 相同且摘要一致时返回原结果。';
COMMENT ON FUNCTION admin.publish_text_postprocess(uuid, uuid, text, integer, timestamptz, text, text, jsonb, jsonb) IS
  '原子发布已保存草稿：不可变快照、runtime_config、config_releases、audit_logs，并标记草稿已发布。';
COMMENT ON FUNCTION admin.rollback_text_postprocess(uuid, uuid, text, integer, integer, jsonb, jsonb) IS
  '按目标快照新建一个版本并切换当前配置。不修改旧快照。';
COMMENT ON FUNCTION admin.discard_text_postprocess_draft(uuid, uuid, text, timestamptz, text) IS
  '按 CAS 删除当前文本后处理草稿。不改变已发布版本。';
COMMENT ON FUNCTION admin.get_text_postprocess_request(uuid, uuid) IS
  '按 request_id 读取已提交结果。没有记录返回 NULL，调用方不得换新 id 盲重试。';

-- 给既有通用写函数插入拒绝分支。CREATE OR REPLACE 保留原权限；锚点不唯一或不存在则失败。
DO $patch$
DECLARE
  r record;
  v_def text;
BEGIN
  FOR r IN
    SELECT *
    FROM (
      VALUES
        (
          'admin.publish_config_draft(uuid)',
          $anchor$IF admin.is_managed_config_key(v_draft.config_key) IS NOT TRUE THEN$anchor$,
          $next$PERFORM admin.reject_generic_text_postprocess_write(v_draft.config_key);

  IF admin.is_managed_config_key(v_draft.config_key) IS NOT TRUE THEN$next$
        ),
        (
          'admin.rollback_config_release(uuid)',
          $anchor$IF admin.is_managed_config_key(v_target.config_key) IS NOT TRUE THEN$anchor$,
          $next$PERFORM admin.reject_generic_text_postprocess_write(v_target.config_key);

  IF admin.is_managed_config_key(v_target.config_key) IS NOT TRUE THEN$next$
        ),
        (
          'admin.upsert_config_draft(text,text,jsonb,text,text)',
          $anchor$PERFORM admin.validate_managed_config_value($anchor$,
          $next$PERFORM admin.reject_generic_text_postprocess_write(p_config_key);

  PERFORM admin.validate_managed_config_value($next$
        ),
        (
          'admin.save_config_draft(text,text,jsonb,text,text)',
          $anchor$PERFORM admin.validate_managed_config_value($anchor$,
          $next$PERFORM admin.reject_generic_text_postprocess_write(p_config_key);

  PERFORM admin.validate_managed_config_value($next$
        ),
        (
          'admin.discard_config_draft(uuid)',
          $anchor$RAISE EXCEPTION 'active draft not found' USING ERRCODE = 'P0002';
  END IF;$anchor$,
          $next$RAISE EXCEPTION 'active draft not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM admin.reject_generic_text_postprocess_write(v_draft.config_key);$next$
        )
    ) AS patch(sig, anchor, replacement)
  LOOP
    v_def := pg_catalog.pg_get_functiondef(r.sig::regprocedure);
    IF position('reject_generic_text_postprocess_write' IN v_def) > 0 THEN
      IF length(v_def) - length(replace(v_def, r.replacement, '')) <> length(r.replacement) THEN
        RAISE EXCEPTION 'text postprocess patched body drifted in %', r.sig;
      END IF;
      CONTINUE;
    END IF;
    IF position(r.anchor IN v_def) = 0 THEN
      RAISE EXCEPTION 'text postprocess patch anchor missing in %', r.sig;
    END IF;
    IF length(v_def) - length(replace(v_def, r.anchor, '')) <> length(r.anchor) THEN
      RAISE EXCEPTION 'text postprocess patch anchor is not unique in %', r.sig;
    END IF;
    EXECUTE replace(v_def, r.anchor, r.replacement);
  END LOOP;
END
$patch$;

DO $selfcheck$
DECLARE
  v_sig text;
  v_src text;
  v_expression text;
BEGIN
  SELECT pg_get_expr(c.conbin, c.conrelid)
    INTO v_expression
  FROM pg_constraint AS c
  WHERE c.conrelid = 'admin.config_drafts'::regclass
    AND c.conname = 'config_drafts_config_key_check';
  IF position('miniapp_text_postprocess_config' IN v_expression) = 0 THEN
    RAISE EXCEPTION 'self-check failed: draft key check was not widened';
  END IF;

  SELECT pg_get_expr(c.conbin, c.conrelid)
    INTO v_expression
  FROM pg_constraint AS c
  WHERE c.conrelid = 'admin.config_releases'::regclass
    AND c.conname = 'config_releases_config_key_check';
  IF position('miniapp_text_postprocess_config' IN v_expression) = 0 THEN
    RAISE EXCEPTION 'self-check failed: release key check was not widened';
  END IF;

  FOREACH v_sig IN ARRAY ARRAY[
    'admin.publish_config_draft(uuid)',
    'admin.rollback_config_release(uuid)',
    'admin.upsert_config_draft(text,text,jsonb,text,text)',
    'admin.save_config_draft(text,text,jsonb,text,text)',
    'admin.discard_config_draft(uuid)'
  ] LOOP
    SELECT p.prosrc INTO v_src
    FROM pg_proc AS p
    WHERE p.oid = v_sig::regprocedure;
    IF position('reject_generic_text_postprocess_write' IN v_src) = 0 THEN
      RAISE EXCEPTION 'self-check failed: % was not patched', v_sig;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
       AND NOT has_function_privilege('authenticated', v_sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'self-check failed: patch removed authenticated execute on %', v_sig;
    END IF;
  END LOOP;

  FOREACH v_sig IN ARRAY ARRAY[
    'admin.save_text_postprocess_draft(uuid,uuid,text,integer,timestamptz,text,text,jsonb)',
    'admin.publish_text_postprocess(uuid,uuid,text,integer,timestamptz,text,text,jsonb,jsonb)',
    'admin.rollback_text_postprocess(uuid,uuid,text,integer,integer,jsonb,jsonb)',
    'admin.discard_text_postprocess_draft(uuid,uuid,text,timestamptz,text)',
    'admin.get_text_postprocess_request(uuid,uuid)'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       AND has_function_privilege('anon', v_sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'self-check failed: anon can execute %', v_sig;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
       AND has_function_privilege('authenticated', v_sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'self-check failed: authenticated can execute %', v_sig;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
       AND NOT has_function_privilege('service_role', v_sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'self-check failed: service_role cannot execute %', v_sig;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
     AND has_function_privilege(
       'service_role',
       'admin.text_postprocess_writer_enter()'::regprocedure,
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'self-check failed: service_role can enter the writer guard directly';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE oid = 'app_core.text_postprocess_versions'::regclass
      AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'self-check failed: text_postprocess_versions RLS is off';
  END IF;
END
$selfcheck$;

-- 历史 artifact 不可变约束即使 session_replication_role=replica 仍执行。
ALTER TABLE app_core.text_postprocess_versions ENABLE ALWAYS TRIGGER trg_text_postprocess_versions_immutable;
ALTER TABLE app_core.text_postprocess_versions ENABLE ALWAYS TRIGGER trg_text_postprocess_versions_no_truncate;

COMMIT;

NOTIFY pgrst, 'reload schema';
