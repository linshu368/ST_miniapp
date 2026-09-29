-- 110: Batch Lab 样本预览与不可变样本集。
-- domain: internal research tooling (batch_lab)
--
-- 仅创建平台写入域；不会修改 experience/app_core 等来源业务对象。
-- 来源只读登录角色的密码必须通过环境 secret 单独配置，不得写入 migration。
-- 执行：仅允许通过手工 Database Migration workflow，先 test，单文件执行。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
  IF to_regclass('experience.chat_history') IS NULL
     OR to_regclass('experience.chat_sessions') IS NULL
     OR to_regclass('app_core.characters') IS NULL THEN
    RAISE EXCEPTION '缺少 Batch Lab 来源表，请先核对目标环境 schema';
  END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS batch_lab;

-- 组角色承载对象 ACL；实际 LOGIN 角色单独承载只读 GUC。密码由部署人员通过 secret
-- 单独设置，migration 不创建可登录凭据；应用不能复用 service_role。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'batch_lab_source_reader') THEN
    CREATE ROLE batch_lab_source_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      INHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'batch_lab_source_login') THEN
    CREATE ROLE batch_lab_source_login NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      INHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$$;

GRANT batch_lab_source_reader TO batch_lab_source_login;

REVOKE ALL ON SCHEMA batch_lab FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA batch_lab TO service_role, postgres;

REVOKE ALL ON SCHEMA experience, app_core FROM batch_lab_source_reader;
GRANT USAGE ON SCHEMA experience, app_core TO batch_lab_source_reader;
REVOKE ALL ON ALL TABLES IN SCHEMA experience, app_core FROM batch_lab_source_reader;
GRANT SELECT ON experience.chat_history, experience.chat_sessions, app_core.characters
  TO batch_lab_source_reader;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA experience, app_core FROM batch_lab_source_reader;
ALTER ROLE batch_lab_source_login SET default_transaction_read_only = on;
ALTER ROLE batch_lab_source_login SET statement_timeout = '5s';
ALTER ROLE batch_lab_source_login SET lock_timeout = '500ms';

-- PUBLIC 的函数 EXECUTE 无法对单个角色做 deny；来源 SQL 预检仍必须拒绝函数调用。
-- default_transaction_read_only 直接配置在实际连接角色，是来源写入的最终数据库级边界。即使某个函数仍由
-- PUBLIC 授权，也不能在该连接事务中写表。不得为方便而给 reader 授予 BYPASSRLS。

CREATE TABLE batch_lab.sql_templates (
  key                TEXT NOT NULL,
  version            INTEGER NOT NULL CHECK (version > 0),
  name               TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description        TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  sql_body           TEXT NOT NULL CHECK (char_length(sql_body) BETWEEN 1 AND 20000),
  parameter_defaults JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(parameter_defaults) = 'object'),
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key, version),
  CONSTRAINT sql_templates_key_format CHECK (key ~ '^[a-z0-9]+(_[a-z0-9]+)*$')
);

CREATE TABLE batch_lab.sample_previews (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  digest              TEXT NOT NULL CHECK (digest ~ '^sha256:[a-f0-9]{64}$'),
  source_environment  TEXT NOT NULL CHECK (source_environment IN ('test', 'production')),
  template_key        TEXT,
  template_version    INTEGER,
  final_sql           TEXT NOT NULL CHECK (char_length(final_sql) BETWEEN 1 AND 20000),
  parameters          JSONB NOT NULL CHECK (jsonb_typeof(parameters) = 'object'),
  sample_limit        INTEGER NOT NULL CHECK (sample_limit BETWEEN 1 AND 500),
  statistics          JSONB NOT NULL CHECK (jsonb_typeof(statistics) = 'object'),
  snapshot_bytes      INTEGER NOT NULL CHECK (snapshot_bytes BETWEEN 0 AND 8388608),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  consumed_at         TIMESTAMPTZ,
  CONSTRAINT preview_template_pair CHECK (
    (template_key IS NULL AND template_version IS NULL)
    OR (template_key IS NOT NULL AND template_version IS NOT NULL)
  ),
  CONSTRAINT preview_expiry_order CHECK (expires_at > created_at),
  FOREIGN KEY (template_key, template_version)
    REFERENCES batch_lab.sql_templates(key, version)
);

CREATE INDEX idx_batch_lab_previews_expiry
  ON batch_lab.sample_previews (expires_at) WHERE consumed_at IS NULL;

CREATE TABLE batch_lab.sample_preview_items (
  preview_id               UUID NOT NULL REFERENCES batch_lab.sample_previews(id) ON DELETE CASCADE,
  ordinal                  INTEGER NOT NULL CHECK (ordinal >= 0),
  source_history_id        UUID NOT NULL,
  source_session_id        UUID NOT NULL,
  source_user_id           UUID NOT NULL,
  source_character_id      UUID NOT NULL,
  turn_index               INTEGER NOT NULL CHECK (turn_index > 0),
  revision                 INTEGER NOT NULL CHECK (revision >= 0),
  user_input               TEXT NOT NULL,
  original_assistant_reply TEXT,
  original_model           TEXT NOT NULL,
  history                  JSONB NOT NULL CHECK (jsonb_typeof(history) = 'array'),
  character_snapshot       JSONB NOT NULL CHECK (jsonb_typeof(character_snapshot) = 'object'),
  dynamic_input_snapshot   JSONB NOT NULL CHECK (jsonb_typeof(dynamic_input_snapshot) = 'object'),
  restoration_strategy     TEXT NOT NULL CHECK (restoration_strategy IN ('exact_prompt_snapshot', 'fixed_start')),
  PRIMARY KEY (preview_id, ordinal),
  UNIQUE (preview_id, source_history_id)
);

CREATE TABLE batch_lab.sample_sets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  source_environment  TEXT NOT NULL CHECK (source_environment IN ('test', 'production')),
  source_preview_id   UUID NOT NULL UNIQUE REFERENCES batch_lab.sample_previews(id),
  source_digest       TEXT NOT NULL CHECK (source_digest ~ '^sha256:[a-f0-9]{64}$'),
  idempotency_key     UUID NOT NULL UNIQUE,
  sample_count        INTEGER NOT NULL CHECK (sample_count BETWEEN 1 AND 500),
  statistics          JSONB NOT NULL CHECK (jsonb_typeof(statistics) = 'object'),
  frozen_sql          TEXT NOT NULL,
  frozen_parameters   JSONB NOT NULL CHECK (jsonb_typeof(frozen_parameters) = 'object'),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_batch_lab_sample_sets_created
  ON batch_lab.sample_sets (created_at DESC, id DESC);

CREATE TABLE batch_lab.sample_snapshots (
  sample_set_id             UUID NOT NULL REFERENCES batch_lab.sample_sets(id) ON DELETE RESTRICT,
  ordinal                  INTEGER NOT NULL CHECK (ordinal >= 0),
  source_history_id        UUID NOT NULL,
  source_session_id        UUID NOT NULL,
  source_user_id           UUID NOT NULL,
  source_character_id      UUID NOT NULL,
  turn_index               INTEGER NOT NULL CHECK (turn_index > 0),
  revision                 INTEGER NOT NULL CHECK (revision >= 0),
  user_input               TEXT NOT NULL,
  original_assistant_reply TEXT,
  original_model           TEXT NOT NULL,
  history                  JSONB NOT NULL CHECK (jsonb_typeof(history) = 'array'),
  character_snapshot       JSONB NOT NULL CHECK (jsonb_typeof(character_snapshot) = 'object'),
  dynamic_input_snapshot   JSONB NOT NULL CHECK (jsonb_typeof(dynamic_input_snapshot) = 'object'),
  restoration_strategy     TEXT NOT NULL CHECK (restoration_strategy IN ('exact_prompt_snapshot', 'fixed_start')),
  PRIMARY KEY (sample_set_id, ordinal),
  UNIQUE (sample_set_id, source_history_id)
);

ALTER TABLE batch_lab.sql_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_lab.sample_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_lab.sample_preview_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_lab.sample_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_lab.sample_snapshots ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES IN SCHEMA batch_lab FROM PUBLIC, anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA batch_lab TO service_role, postgres;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA batch_lab TO service_role, postgres;
ALTER DEFAULT PRIVILEGES IN SCHEMA batch_lab REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA batch_lab GRANT ALL ON TABLES TO service_role, postgres;

CREATE OR REPLACE FUNCTION batch_lab.create_sample_preview(
  p_digest TEXT,
  p_source_environment TEXT,
  p_template_key TEXT,
  p_template_version INTEGER,
  p_final_sql TEXT,
  p_parameters JSONB,
  p_sample_limit INTEGER,
  p_statistics JSONB,
  p_snapshot_bytes INTEGER,
  p_expires_at TIMESTAMPTZ,
  p_items JSONB
) RETURNS SETOF batch_lab.sample_previews
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_preview batch_lab.sample_previews%ROWTYPE;
  v_inserted INTEGER;
BEGIN
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 500 THEN
    RAISE EXCEPTION 'BATCH_LAB_CAPACITY_EXCEEDED' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at <= now()
     OR COALESCE((p_statistics ->> 'valid_count')::integer, -1) <> jsonb_array_length(p_items)
     OR COALESCE((p_statistics ->> 'snapshot_bytes')::integer, -1) <> p_snapshot_bytes THEN
    RAISE EXCEPTION 'BATCH_LAB_PREVIEW_MISMATCH' USING ERRCODE = '22023';
  END IF;

  INSERT INTO batch_lab.sample_previews (
    digest, source_environment, template_key, template_version, final_sql,
    parameters, sample_limit, statistics, snapshot_bytes, expires_at
  ) VALUES (
    p_digest, p_source_environment, p_template_key, p_template_version, p_final_sql,
    p_parameters, p_sample_limit, p_statistics, p_snapshot_bytes, p_expires_at
  ) RETURNING * INTO v_preview;

  INSERT INTO batch_lab.sample_preview_items (
    preview_id, ordinal, source_history_id, source_session_id, source_user_id,
    source_character_id, turn_index, revision, user_input, original_assistant_reply,
    original_model, history, character_snapshot, dynamic_input_snapshot, restoration_strategy
  )
  SELECT v_preview.id, item.ordinal, item.source_history_id, item.source_session_id,
    item.source_user_id, item.source_character_id, item.turn_index, item.revision,
    item.user_input, item.original_assistant_reply, item.original_model, item.history,
    item.character_snapshot, item.dynamic_input_snapshot, item.restoration_strategy
  FROM jsonb_to_recordset(p_items) AS item(
    ordinal INTEGER,
    source_history_id UUID,
    source_session_id UUID,
    source_user_id UUID,
    source_character_id UUID,
    turn_index INTEGER,
    revision INTEGER,
    user_input TEXT,
    original_assistant_reply TEXT,
    original_model TEXT,
    history JSONB,
    character_snapshot JSONB,
    dynamic_input_snapshot JSONB,
    restoration_strategy TEXT
  );

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'BATCH_LAB_PREVIEW_MISMATCH' USING ERRCODE = '22023';
  END IF;

  RETURN NEXT v_preview;
END;
$$;

CREATE OR REPLACE FUNCTION batch_lab.freeze_sample_set(
  p_name TEXT,
  p_preview_id UUID,
  p_preview_digest TEXT,
  p_source_environment TEXT,
  p_idempotency_key UUID
) RETURNS SETOF batch_lab.sample_sets
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_preview batch_lab.sample_previews%ROWTYPE;
  v_set batch_lab.sample_sets%ROWTYPE;
  v_count INTEGER;
BEGIN
  -- 同一个 idempotency key 的并发调用先串行化；第二个调用等待后会命中已有结果。
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_idempotency_key::text, 0)
  );

  SELECT * INTO v_set FROM batch_lab.sample_sets WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_set.source_preview_id <> p_preview_id
       OR v_set.source_digest <> p_preview_digest
       OR v_set.source_environment <> p_source_environment
       OR v_set.name <> btrim(p_name) THEN
      RAISE EXCEPTION 'BATCH_LAB_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN NEXT v_set;
    RETURN;
  END IF;

  SELECT * INTO v_preview
  FROM batch_lab.sample_previews
  WHERE id = p_preview_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BATCH_LAB_PREVIEW_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_preview.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'BATCH_LAB_PREVIEW_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF v_preview.expires_at <= now() THEN
    RAISE EXCEPTION 'BATCH_LAB_PREVIEW_EXPIRED' USING ERRCODE = '22023';
  END IF;
  IF v_preview.digest <> p_preview_digest
     OR v_preview.source_environment <> p_source_environment THEN
    RAISE EXCEPTION 'BATCH_LAB_PREVIEW_MISMATCH' USING ERRCODE = '22023';
  END IF;

  SELECT count(*)::integer INTO v_count
  FROM batch_lab.sample_preview_items
  WHERE preview_id = p_preview_id;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'BATCH_LAB_EMPTY_PREVIEW' USING ERRCODE = '22023';
  END IF;

  INSERT INTO batch_lab.sample_sets (
    name, source_environment, source_preview_id, source_digest, idempotency_key,
    sample_count, statistics, frozen_sql, frozen_parameters
  ) VALUES (
    btrim(p_name), v_preview.source_environment, v_preview.id, v_preview.digest,
    p_idempotency_key, v_count, v_preview.statistics, v_preview.final_sql, v_preview.parameters
  ) RETURNING * INTO v_set;

  INSERT INTO batch_lab.sample_snapshots
  SELECT v_set.id, item.ordinal, item.source_history_id, item.source_session_id,
    item.source_user_id, item.source_character_id, item.turn_index, item.revision,
    item.user_input, item.original_assistant_reply, item.original_model, item.history,
    item.character_snapshot, item.dynamic_input_snapshot, item.restoration_strategy
  FROM batch_lab.sample_preview_items AS item
  WHERE item.preview_id = p_preview_id
  ORDER BY item.ordinal;

  UPDATE batch_lab.sample_previews SET consumed_at = now() WHERE id = p_preview_id;
  RETURN NEXT v_set;
END;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA batch_lab FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION batch_lab.create_sample_preview(
  TEXT, TEXT, TEXT, INTEGER, TEXT, JSONB, INTEGER, JSONB, INTEGER, TIMESTAMPTZ, JSONB
) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION batch_lab.freeze_sample_set(TEXT, UUID, TEXT, TEXT, UUID)
  TO service_role, postgres;

COMMENT ON SCHEMA batch_lab IS '内部 Batch Lab 冻结样本与后续实验数据域；真实业务域不得依赖。';
COMMENT ON FUNCTION batch_lab.create_sample_preview(
  TEXT, TEXT, TEXT, INTEGER, TEXT, JSONB, INTEGER, JSONB, INTEGER, TIMESTAMPTZ, JSONB
) IS '在单事务内持久化 preview 元数据与同批候选快照。';
COMMENT ON FUNCTION batch_lab.freeze_sample_set(TEXT, UUID, TEXT, TEXT, UUID) IS
  '一次性消费未过期 preview，在单事务内冻结同批快照；幂等键由数据库唯一约束裁决。';

COMMIT;

-- test 验证（执行后人工运行，不属于 migration 事务）：
-- 1. SELECT relname, relrowsecurity FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace
--      WHERE n.nspname='batch_lab';
-- 2. SET ROLE anon; SELECT * FROM batch_lab.sample_sets; -- 必须 permission denied
-- 3. 人工给 batch_lab_source_login 设置随机密码并启用 LOGIN；必须用该角色新建真实连接，确认
--      transaction_read_only=on，INSERT/UPDATE/DELETE/TRUNCATE/DDL/nextval/volatile 写函数均失败。
-- 4. rollback/forward-fix：feature flag 关闭后可保留 schema；若确认无数据/无 consumer，
--      单独审核 DROP SCHEMA batch_lab CASCADE 与 DROP ROLE 两个 batch_lab_source_* 角色。