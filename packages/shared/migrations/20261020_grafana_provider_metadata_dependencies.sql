-- domain: miniapp_analytics
-- Compatibility repair of the existing analytics_grafana surface; creates no new schema.
-- Run before the immutable OpenRouter alias/parent contracts. Never DROP CASCADE.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = pg_catalog, pg_temp;

CREATE TEMP TABLE grafana_retirement_objects ON COMMIT DROP AS
SELECT c.oid AS old_oid, c.relname::text AS name, c.relkind AS kind,
  pg_get_viewdef(c.oid,true) AS old_definition, pg_get_viewdef(c.oid,true) AS new_definition,
  pg_get_userbyid(c.relowner) AS owner_name, c.relacl AS permissions,
  obj_description(c.oid) AS comment, c.reloptions AS options,
  (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',a.atttypid,
      'typmod',a.atttypmod,'collation',a.attcollation,'number',a.attnum,
      'acl',a.attacl,'comment',col_description(c.oid,a.attnum)) ORDER BY a.attnum)
    FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='analytics_grafana' AND c.relkind IN ('v','m')
  AND c.relname IN ('v_llm_calls','mv_free_quota_daily','mv_card_unit_economics_30d',
    'v_free_quota_daily','v_card_unit_economics_30d');

CREATE TEMP TABLE grafana_retirement_indexes ON COMMIT DROP AS
SELECT t.relname::text AS name, i.relname::text AS index_name, pg_get_indexdef(i.oid) AS definition, obj_description(i.oid) AS comment
FROM pg_index x JOIN pg_class t ON t.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid
WHERE t.oid IN (SELECT old_oid FROM grafana_retirement_objects WHERE kind='m');

CREATE TEMP TABLE grafana_alias_candidates(id uuid PRIMARY KEY) ON COMMIT DROP;

DO $preflight$
DECLARE
  target record;
  field_name text;
  conflict boolean;
  pending bigint;
BEGIN
  IF to_regnamespace('analytics_grafana') IS NULL THEN
    RAISE NOTICE 'Grafana provider repair skipped: analytics_grafana is absent';
    RETURN;
  END IF;
  IF (SELECT count(*) FROM grafana_retirement_objects)<>5 THEN
    RAISE EXCEPTION 'Grafana provider repair requires all five known objects';
  END IF;
  -- A completed repair is safe to re-enter after SQL commit but before ledger recording.
  IF NOT EXISTS (
    SELECT 1 FROM pg_depend d JOIN pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid
    WHERE d.refclassid='pg_class'::regclass AND d.classid='pg_rewrite'::regclass
      AND d.objid IN (SELECT r.oid FROM pg_rewrite r WHERE r.ev_class IN
        (SELECT old_oid FROM grafana_retirement_objects))
      AND ((a.attrelid='experience.openrouter_chat_history'::regclass
        AND a.attname LIKE 'llm\_%' ESCAPE '\' AND a.attname NOT IN ('llm_generation_id','llm_generation_data'))
        OR (a.attrelid='experience.chat_history'::regclass
        AND a.attname=ANY(ARRAY['llm_provider_name','llm_usage','llm_usage_cache',
          'llm_native_tokens_cached','llm_native_tokens_reasoning','llm_native_tokens_completion',
          'llm_native_tokens_prompt','llm_latency','llm_generation_time','llm_model',
          'llm_generation_id','llm_generation_data'])))
  ) THEN
    DELETE FROM grafana_retirement_objects;
    DELETE FROM grafana_retirement_indexes;
    RAISE NOTICE 'Grafana provider repair skipped: known objects already have no retired-column dependencies';
    RETURN;
  END IF;
  -- Deparsed source fingerprints make the text edits specific to the reviewed production definitions.
  FOR target IN SELECT * FROM (VALUES
    ('v_llm_calls','v','3018ea67ffdfd81f4e52586a1f772119'),
    ('mv_free_quota_daily','m','2858ad943521ba1aae322370bf280fd7'),
    ('mv_card_unit_economics_30d','m','9428f11567607b6733ead3753feca9da'),
    ('v_free_quota_daily','v','4d424cf6385e3e9fdd4a5d717f2d3820'),
    ('v_card_unit_economics_30d','v','b89e813923a1e58836413c793a5248e3')
  ) AS expected(name,kind,digest) LOOP
    IF NOT EXISTS (SELECT 1 FROM grafana_retirement_objects o
      WHERE o.name=target.name AND o.kind=target.kind::"char"
        AND md5(o.old_definition)=target.digest) THEN
      RAISE EXCEPTION 'Grafana definition drift: %',target.name;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM grafana_retirement_objects o JOIN pg_class c ON c.oid=o.old_oid
    WHERE o.kind='m' AND (NOT c.relispopulated OR c.reloptions IS NOT NULL
      OR c.reltablespace<>0 OR c.relam<>(SELECT oid FROM pg_am WHERE amname='heap'))) THEN
    RAISE EXCEPTION 'Unexpected Grafana materialized-view storage shape';
  END IF;
  IF EXISTS (SELECT 1 FROM grafana_retirement_objects o,
    LATERAL aclexplode(coalesce(o.permissions,acldefault('r',o.owner_name::regrole))) a
    WHERE a.grantor<>o.owner_name::regrole) THEN
    RAISE EXCEPTION 'Unexpected Grafana privilege grantor';
  END IF;
  IF (SELECT count(*) FROM grafana_retirement_indexes)<>2 OR EXISTS (
    SELECT 1 FROM grafana_retirement_indexes WHERE definition NOT IN (
      'CREATE UNIQUE INDEX mv_free_quota_daily_uidx ON analytics_grafana.mv_free_quota_daily USING btree (metric_date, quota_limit, user_type, status)',
      'CREATE UNIQUE INDEX mv_card_unit_economics_30d_character_label_idx ON analytics_grafana.mv_card_unit_economics_30d USING btree (character_label)'
    )
  ) THEN RAISE EXCEPTION 'Unexpected Grafana materialized-view indexes'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_depend d JOIN pg_rewrite r ON r.oid=d.objid
    JOIN grafana_retirement_objects o ON o.old_oid=d.refobjid AND o.kind='m'
    WHERE d.refclassid='pg_class'::regclass AND d.classid='pg_rewrite'::regclass
      AND r.ev_class<>o.old_oid AND r.ev_class<>
        to_regclass(format('analytics_grafana.%I',replace(o.name,'mv_','v_')))
  ) THEN RAISE EXCEPTION 'Unknown Grafana materialized-view dependent'; END IF;
  IF EXISTS (SELECT 1 FROM grafana_retirement_objects WHERE kind='m' AND
    (to_regclass(format('analytics_grafana.%I',name||'_or_new')) IS NOT NULL
    OR to_regclass(format('analytics_grafana.%I',name||'_or_old')) IS NOT NULL
    OR to_regclass(format('analytics_grafana.%I',name||'_or_uidx')) IS NOT NULL)) THEN
    RAISE EXCEPTION 'Grafana staging name already exists';
  END IF;

  IF EXISTS (SELECT 1 FROM experience.openrouter_chat_history o
    JOIN experience.venice_chat_history v USING(chat_history_id)) THEN
    RAISE EXCEPTION 'Grafana provider overlap';
  END IF;

  -- The original alias contract could not fill these NULLs until its dependents were fixed.
  -- Preserve the same conflict and 2000-row budget before letting reports read canonical facts.
  FOR field_name IN SELECT unnest(ARRAY['provider_name','finish_reason','usage','usage_cache',
    'native_tokens_cached','native_tokens_reasoning','native_tokens_completion','native_tokens_prompt',
    'latency','generation_time','model']) LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM experience.openrouter_chat_history WHERE %1$I IS NOT NULL AND %2$I IS NOT NULL AND %1$I IS DISTINCT FROM %2$I)',
      field_name,'llm_'||field_name) INTO conflict;
    IF conflict THEN RAISE EXCEPTION 'Conflicting Grafana alias/canonical facts: %',field_name; END IF;
    UPDATE grafana_retirement_objects SET new_definition=
      replace(new_definition,'o.llm_'||field_name,'o.'||field_name);
    IF field_name<>'finish_reason' THEN
      UPDATE grafana_retirement_objects SET new_definition=
        replace(new_definition,'ch.llm_'||field_name,'o.'||field_name);
    END IF;
  END LOOP;
  UPDATE grafana_retirement_objects SET new_definition=
    replace(new_definition,'ch.llm_generation_id','o.llm_generation_id');
  INSERT INTO grafana_alias_candidates(id)
  SELECT id FROM experience.openrouter_chat_history WHERE
    (provider_name IS NULL AND llm_provider_name IS NOT NULL) OR
    (finish_reason IS NULL AND llm_finish_reason IS NOT NULL) OR
    (usage IS NULL AND llm_usage IS NOT NULL) OR (usage_cache IS NULL AND llm_usage_cache IS NOT NULL) OR
    (native_tokens_cached IS NULL AND llm_native_tokens_cached IS NOT NULL) OR
    (native_tokens_reasoning IS NULL AND llm_native_tokens_reasoning IS NOT NULL) OR
    (native_tokens_completion IS NULL AND llm_native_tokens_completion IS NOT NULL) OR
    (native_tokens_prompt IS NULL AND llm_native_tokens_prompt IS NOT NULL) OR
    (latency IS NULL AND llm_latency IS NOT NULL) OR
    (generation_time IS NULL AND llm_generation_time IS NOT NULL) OR (model IS NULL AND llm_model IS NOT NULL)
  LIMIT 2001;
  SELECT count(*) INTO pending FROM grafana_alias_candidates;
  IF pending>2000 THEN RAISE EXCEPTION 'Grafana alias catch-up exceeds reviewed 2000-row budget'; END IF;
END
$preflight$;

-- No rows are produced on TEST without this external reporting schema, or on safe re-entry.
-- Each generated command is a separate statement with the unchanged 60s timeout.
SELECT $sql$
UPDATE experience.openrouter_chat_history SET
  provider_name=coalesce(provider_name,llm_provider_name), finish_reason=coalesce(finish_reason,llm_finish_reason),
  usage=coalesce(usage,llm_usage), usage_cache=coalesce(usage_cache,llm_usage_cache),
  native_tokens_cached=coalesce(native_tokens_cached,llm_native_tokens_cached),
  native_tokens_reasoning=coalesce(native_tokens_reasoning,llm_native_tokens_reasoning),
  native_tokens_completion=coalesce(native_tokens_completion,llm_native_tokens_completion),
  native_tokens_prompt=coalesce(native_tokens_prompt,llm_native_tokens_prompt),
  latency=coalesce(latency,llm_latency), generation_time=coalesce(generation_time,llm_generation_time),
  model=coalesce(model,llm_model)
WHERE id IN (SELECT id FROM grafana_alias_candidates) AND (
  (provider_name IS NULL AND llm_provider_name IS NOT NULL) OR
  (finish_reason IS NULL AND llm_finish_reason IS NOT NULL) OR
  (usage IS NULL AND llm_usage IS NOT NULL) OR (usage_cache IS NULL AND llm_usage_cache IS NOT NULL) OR
  (native_tokens_cached IS NULL AND llm_native_tokens_cached IS NOT NULL) OR
  (native_tokens_reasoning IS NULL AND llm_native_tokens_reasoning IS NOT NULL) OR
  (native_tokens_completion IS NULL AND llm_native_tokens_completion IS NOT NULL) OR
  (native_tokens_prompt IS NULL AND llm_native_tokens_prompt IS NOT NULL) OR
  (latency IS NULL AND llm_latency IS NOT NULL) OR
  (generation_time IS NULL AND llm_generation_time IS NOT NULL) OR (model IS NULL AND llm_model IS NOT NULL))
$sql$ WHERE EXISTS (SELECT 1 FROM grafana_retirement_objects)
\gexec

-- Stage populated replacements before acquiring locks on the current reporting surface.
SELECT format('CREATE MATERIALIZED VIEW analytics_grafana.%I AS %s WITH DATA',
  name||'_or_new',rtrim(new_definition,';'))
FROM grafana_retirement_objects WHERE kind='m' ORDER BY name
\gexec
SELECT CASE WHEN name='mv_free_quota_daily'
  THEN format('CREATE UNIQUE INDEX %I ON analytics_grafana.%I (metric_date,quota_limit,user_type,status)',name||'_or_uidx',name||'_or_new')
  ELSE format('CREATE UNIQUE INDEX %I ON analytics_grafana.%I (character_label)',name||'_or_uidx',name||'_or_new') END
FROM grafana_retirement_objects WHERE kind='m' ORDER BY name
\gexec

DO $cutover$
DECLARE
  target record;
  permission record;
  column_info jsonb;
  new_oid oid;
  current_columns jsonb;
BEGIN
  -- Lock and recheck all originals after staging: external DDL must not be overwritten.
  FOR target IN SELECT * FROM grafana_retirement_objects ORDER BY name LOOP
    IF to_regclass(format('analytics_grafana.%I',target.name)) IS DISTINCT FROM target.old_oid THEN
      RAISE EXCEPTION 'Grafana object changed during staging: %',target.name;
    END IF;
    -- A same-schema ALTER takes only the object DDL lock without changing its metadata.
    IF target.kind='m' THEN
      EXECUTE format('ALTER MATERIALIZED VIEW analytics_grafana.%I SET SCHEMA analytics_grafana',target.name);
    ELSE
      EXECUTE format('ALTER VIEW analytics_grafana.%I SET SCHEMA analytics_grafana',target.name);
    END IF;
    SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',a.atttypid,
      'typmod',a.atttypmod,'collation',a.attcollation,'number',a.attnum,
      'acl',a.attacl,'comment',col_description(target.old_oid,a.attnum)) ORDER BY a.attnum)
      INTO current_columns FROM pg_attribute a WHERE a.attrelid=target.old_oid AND a.attnum>0 AND NOT a.attisdropped;
    IF current_columns IS DISTINCT FROM target.columns THEN
      RAISE EXCEPTION 'Grafana columns changed during staging: %',target.name;
    END IF;
    IF pg_get_viewdef(target.old_oid,true) IS DISTINCT FROM target.old_definition
       OR EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=target.old_oid AND
         (pg_get_userbyid(c.relowner)<>target.owner_name OR c.relacl IS DISTINCT FROM target.permissions
           OR c.reloptions IS DISTINCT FROM target.options OR obj_description(c.oid) IS DISTINCT FROM target.comment)) THEN
      RAISE EXCEPTION 'Grafana definition changed during staging: %',target.name;
    END IF;
  END LOOP;
  IF EXISTS (
    WITH current_indexes AS (
      SELECT t.relname::text AS name,i.relname::text AS index_name,
        pg_get_indexdef(i.oid) AS definition,obj_description(i.oid) AS comment
      FROM pg_index x JOIN pg_class t ON t.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid
      WHERE t.oid IN (SELECT old_oid FROM grafana_retirement_objects WHERE kind='m')
    )
    (SELECT * FROM current_indexes EXCEPT SELECT * FROM grafana_retirement_indexes)
    UNION ALL
    (SELECT * FROM grafana_retirement_indexes EXCEPT SELECT * FROM current_indexes)
  ) THEN RAISE EXCEPTION 'Grafana indexes changed during staging'; END IF;
  FOR target IN SELECT * FROM grafana_retirement_objects WHERE kind='m' ORDER BY name LOOP
    EXECUTE format('ALTER MATERIALIZED VIEW analytics_grafana.%I RENAME TO %I',target.name,target.name||'_or_old');
    EXECUTE format('ALTER MATERIALIZED VIEW analytics_grafana.%I RENAME TO %I',target.name||'_or_new',target.name);
    EXECUTE format('ALTER MATERIALIZED VIEW analytics_grafana.%I OWNER TO %I',target.name,target.owner_name);
    new_oid:=to_regclass(format('analytics_grafana.%I',target.name));
    -- Default privileges on newly created relations must not broaden the old ACL.
    FOR permission IN SELECT DISTINCT a.grantee FROM pg_class c,
      LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=new_oid LOOP
      EXECUTE format('REVOKE ALL ON TABLE analytics_grafana.%I FROM %s',target.name,
        CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END);
    END LOOP;
    FOR permission IN SELECT * FROM aclexplode(coalesce(target.permissions,acldefault('r',target.owner_name::regrole))) LOOP
      EXECUTE format('GRANT %s ON TABLE analytics_grafana.%I TO %s%s',permission.privilege_type,target.name,
        CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
        CASE WHEN permission.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
    EXECUTE format('COMMENT ON MATERIALIZED VIEW analytics_grafana.%I IS %L',target.name,target.comment);
    FOR column_info IN SELECT * FROM jsonb_array_elements(target.columns) LOOP
      EXECUTE format('COMMENT ON COLUMN analytics_grafana.%I.%I IS %L',target.name,column_info->>'name',column_info->>'comment');
      IF column_info->>'acl' IS NOT NULL THEN
        RAISE EXCEPTION 'Unexpected Grafana materialized-view column ACL';
      END IF;
    END LOOP;
  END LOOP;
  -- Reparse the two wrappers against the new same-named MVs, keeping wrapper OIDs/ACLs.
  FOR target IN SELECT * FROM grafana_retirement_objects WHERE kind='v' ORDER BY name LOOP
    EXECUTE format('CREATE OR REPLACE VIEW analytics_grafana.%I AS %s',target.name,target.new_definition);
  END LOOP;
  FOR target IN SELECT * FROM grafana_retirement_objects WHERE kind='m' ORDER BY name LOOP
    EXECUTE format('DROP MATERIALIZED VIEW analytics_grafana.%I RESTRICT',target.name||'_or_old');
    EXECUTE format('ALTER INDEX analytics_grafana.%I RENAME TO %I',target.name||'_or_uidx',
      (SELECT index_name FROM grafana_retirement_indexes WHERE name=target.name));
    EXECUTE format('COMMENT ON INDEX analytics_grafana.%I IS %L',
      (SELECT index_name FROM grafana_retirement_indexes WHERE name=target.name),
      (SELECT comment FROM grafana_retirement_indexes WHERE name=target.name));
  END LOOP;
  FOR target IN SELECT * FROM grafana_retirement_objects LOOP
    new_oid:=to_regclass(format('analytics_grafana.%I',target.name));
    SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',a.atttypid,
      'typmod',a.atttypmod,'collation',a.attcollation,'number',a.attnum,
      'acl',a.attacl,'comment',col_description(new_oid,a.attnum)) ORDER BY a.attnum)
      INTO current_columns FROM pg_attribute a WHERE a.attrelid=new_oid AND a.attnum>0 AND NOT a.attisdropped;
    IF current_columns IS DISTINCT FROM target.columns THEN
      RAISE EXCEPTION 'Grafana output contract changed: %',target.name;
    END IF;
    IF target.kind='v' AND new_oid<>target.old_oid THEN
      RAISE EXCEPTION 'Grafana wrapper identity changed: %',target.name;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=new_oid AND
      (pg_get_userbyid(c.relowner)<>target.owner_name OR c.reloptions IS DISTINCT FROM target.options
        OR obj_description(c.oid) IS DISTINCT FROM target.comment)) THEN
      RAISE EXCEPTION 'Grafana ownership/options/comments changed: %',target.name;
    END IF;
    IF EXISTS (
      (SELECT grantee,privilege_type,is_grantable FROM aclexplode(coalesce(target.permissions,acldefault('r',target.owner_name::regrole)))
       EXCEPT SELECT a.grantee,a.privilege_type,a.is_grantable FROM pg_class c,
         LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=new_oid)
      UNION ALL
      (SELECT a.grantee,a.privilege_type,a.is_grantable FROM pg_class c,
         LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=new_oid
       EXCEPT SELECT grantee,privilege_type,is_grantable FROM aclexplode(coalesce(target.permissions,acldefault('r',target.owner_name::regrole))))
    ) THEN RAISE EXCEPTION 'Grafana ACL changed: %',target.name; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_depend d JOIN pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid
    JOIN pg_rewrite r ON r.oid=d.objid JOIN pg_class v ON v.oid=r.ev_class
    JOIN pg_namespace n ON n.oid=v.relnamespace
    WHERE d.refclassid='pg_class'::regclass AND d.classid='pg_rewrite'::regclass
      AND n.nspname='analytics_grafana'
      AND ((a.attrelid='experience.openrouter_chat_history'::regclass AND a.attname LIKE 'llm\_%' ESCAPE '\'
        AND a.attname NOT IN ('llm_generation_id','llm_generation_data'))
        OR (a.attrelid='experience.chat_history'::regclass AND a.attname=ANY(ARRAY[
          'llm_provider_name','llm_usage','llm_usage_cache','llm_native_tokens_cached','llm_native_tokens_reasoning',
          'llm_native_tokens_completion','llm_native_tokens_prompt','llm_latency','llm_generation_time',
          'llm_model','llm_generation_id','llm_generation_data'])))) THEN
    RAISE EXCEPTION 'Grafana retired-column dependency remains';
  END IF;
END
$cutover$;
COMMIT;
-- Any failure rolls back metadata fills, staged MVs and cutover together. No automatic retry.
-- Refresh jobs keep the original MV names and unique indexes; no schedule/cron changes.
