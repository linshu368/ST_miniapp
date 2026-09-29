-- Local scenarios for the text-postprocess migrations. Never apply this file to test or production.

CREATE SCHEMA IF NOT EXISTS text_postprocess_t2;

CREATE OR REPLACE FUNCTION text_postprocess_t2.assert(p_ok boolean, p_msg text)
RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NOT COALESCE(p_ok, false) THEN
    RAISE EXCEPTION 'T2 scenario failed: %', p_msg;
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION text_postprocess_t2.expect_sqlstate(
  p_sql text,
  p_sqlstate text,
  p_msg text
) RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_raised boolean := false;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
    IF SQLSTATE IS DISTINCT FROM p_sqlstate THEN
      RAISE EXCEPTION 'T2 scenario failed: % raised % (%), expected %',
        p_msg, SQLSTATE, SQLERRM, p_sqlstate;
    END IF;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'T2 scenario failed: % did not raise', p_msg;
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION text_postprocess_t2.fail_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF to_regclass('pg_temp.text_postprocess_t2_fail_audit') IS NOT NULL THEN
    RAISE EXCEPTION 'injected audit failure' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION text_postprocess_t2.overwrite_artifact()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
  UPDATE app_core.text_postprocess_versions SET artifact=NULL WHERE version=1;
$fn$;

-- 固定离线 fixture，不是 SQL compiler：只覆盖本文件的 p/button 文本样例。
CREATE OR REPLACE FUNCTION text_postprocess_t2.artifact(p_source jsonb)
RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_object('schema_version',1,'policy_version',1,'rules',COALESCE(jsonb_agg(
    jsonb_build_object('id',r->'id','enabled',r->'enabled','pattern',r->'pattern','flags',r->'flags',
      'groups',jsonb_build_object('count',0,'names','[]'::jsonb,'name_by_index','[]'::jsonb),
      'placement','block','tree',jsonb_build_array(jsonb_build_object('type','text','text','fixture')),'css','[]'::jsonb)
    ORDER BY ordinal), '[]'::jsonb))
  FROM jsonb_array_elements(p_source->'rules') WITH ORDINALITY AS rules(r,ordinal);
$fn$;

CREATE OR REPLACE FUNCTION text_postprocess_t2.run()
RETURNS text
LANGUAGE plpgsql
AS $fn$
DECLARE
  c_owner uuid := '00000000-0000-4000-8000-0000000000a1';
  c_viewer uuid := '00000000-0000-4000-8000-0000000000a2';
  c_blocked uuid := '00000000-0000-4000-8000-0000000000a3';
  c_session uuid := '00000000-0000-4000-8000-0000000000b1';
  c_session_null uuid := '00000000-0000-4000-8000-0000000000b2';
  c_user uuid := '00000000-0000-4000-8000-0000000000c1';
  c_save uuid := '00000000-0000-4000-8000-000000000101';
  c_save_replay uuid := '00000000-0000-4000-8000-000000000102';
  c_save_conflict uuid := '00000000-0000-4000-8000-000000000103';
  c_publish uuid := '00000000-0000-4000-8000-000000000104';
  c_publish_bad uuid := '00000000-0000-4000-8000-000000000105';
  c_rollback uuid := '00000000-0000-4000-8000-000000000106';
  c_discard uuid := '00000000-0000-4000-8000-000000000107';
  c_audit_fail uuid := '00000000-0000-4000-8000-000000000108';
  d_req_save text := repeat('11', 32);
  d_req_save_other text := repeat('12', 32);
  d_req_publish text := repeat('21', 32);
  d_req_publish_bad text := repeat('22', 32);
  d_req_rollback text := repeat('31', 32);
  d_req_discard text := repeat('41', 32);
  d_req_audit text := repeat('51', 32);
  d_bad text := repeat('ab', 32);
  d_good text := repeat('cd', 32);
  d_next text := repeat('ef', 32);
  v_bad jsonb;
  v_good jsonb;
  v_next jsonb;
  v_save jsonb;
  v_publish jsonb;
  v_rollback jsonb;
  v_discard jsonb;
  v_started jsonb;
  v_old_published timestamptz;
  v_version_count integer;
  v_hook integer;
  v_old_version integer;
  v_new_version integer;
BEGIN
  v_bad := jsonb_build_object(
    'schema_version', 1,
    'policy_version', 1,
    'rules', jsonb_build_array(jsonb_build_object(
      'id', 'dialogue', 'name', '对白', 'description', '', 'enabled', true,
      'pattern', 'x', 'flags', 'gg', 'replacement', '<p>$&</p>', 'css', '', 'notes', ''
    ))
  );
  v_good := jsonb_build_object(
    'schema_version', 1,
    'policy_version', 1,
    'rules', jsonb_build_array(jsonb_build_object(
      'id', 'dialogue', 'name', '对白', 'description', '', 'enabled', true,
      'pattern', 'x', 'flags', 'g', 'replacement', '<p>script</p>', 'css', '', 'notes', ''
    ))
  );
  v_next := jsonb_build_object(
    'schema_version', 1,
    'policy_version', 1,
    'rules', jsonb_build_array(jsonb_build_object(
      'id', 'status', 'name', '状态', 'description', '', 'enabled', false,
      'pattern', 'y', 'flags', '', 'replacement', '<p>$&</p>', 'css', '', 'notes', ''
    ))
  );

  INSERT INTO admin.admin_users (user_id, email, role, can_access_test, can_access_prod)
  VALUES
    (c_owner, 'owner@example.com', 'owner', true, false),
    (c_viewer, 'viewer@example.com', 'viewer', true, false),
    (c_blocked, 'blocked@example.com', 'operator', false, false);

  -- Supabase's postgres role is not a superuser: the dedicated SECURITY DEFINER publisher needs
  -- an explicit INSERT grant, while the Backend's service role must still be unable to write.
  PERFORM text_postprocess_t2.assert(
    EXISTS (
      SELECT 1
      FROM pg_class AS relation
      CROSS JOIN LATERAL aclexplode(relation.relacl) AS privilege
      WHERE relation.oid = 'app_core.text_postprocess_versions'::regclass
        AND privilege.grantee = 'postgres'::regrole
        AND privilege.privilege_type = 'INSERT'
    ),
    'publisher owner has explicit snapshot INSERT privilege'
  );
  PERFORM text_postprocess_t2.assert(
    has_table_privilege('postgres', 'app_core.text_postprocess_versions', 'SELECT')
      AND has_table_privilege('service_role', 'app_core.text_postprocess_versions', 'SELECT'),
    'conversation wrappers and Backend can read snapshots'
  );
  PERFORM text_postprocess_t2.assert(
    NOT EXISTS (
      SELECT 1
      FROM pg_class AS relation
      CROSS JOIN LATERAL aclexplode(relation.relacl) AS privilege
      WHERE relation.oid = 'app_core.text_postprocess_versions'::regclass
        AND privilege.grantee = 'service_role'::regrole
        AND privilege.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    ),
    'service role remains snapshot read-only'
  );

  PERFORM text_postprocess_t2.expect_sqlstate(
    format(
      $q$SELECT admin.save_text_postprocess_draft(%L, %L, %L, NULL, NULL, NULL, %L, %L::jsonb)$q$,
      c_viewer, c_save, d_req_save, d_bad, v_bad::text
    ),
    '42501',
    'viewer cannot save'
  );
  PERFORM text_postprocess_t2.expect_sqlstate(
    format(
      $q$SELECT admin.save_text_postprocess_draft(%L, %L, %L, NULL, NULL, NULL, %L, %L::jsonb)$q$,
      c_blocked, c_save, d_req_save, d_bad, v_bad::text
    ),
    '42501',
    'cross-environment operator cannot save'
  );
  PERFORM text_postprocess_t2.expect_sqlstate(
    format(
      $q$SELECT admin.validate_text_postprocess_source(%L::jsonb, 'draft')$q$,
      '{"schema_version":1,"policy_version":1,"rules":[],"extra":true}'
    ),
    '22023',
    'unknown source field'
  );
  PERFORM text_postprocess_t2.expect_sqlstate(
    $q$SELECT admin.validate_text_postprocess_source(
      jsonb_build_object(
        'schema_version', 1,
        'policy_version', 1,
        'rules', (
          SELECT jsonb_agg(jsonb_build_object(
            'id', 'r' || g, 'name', 'n', 'description', '', 'enabled', true,
            'pattern', 'x', 'flags', 'g', 'replacement', '', 'css', '', 'notes', ''
          ))
          FROM generate_series(1, 101) AS g
        )
      ),
      'draft'
    )$q$,
    '22023',
    'too many rules'
  );

  PERFORM text_postprocess_t2.assert(
    admin.get_text_postprocess_request(c_owner, c_save) IS NULL,
    'unknown request is null'
  );
  PERFORM text_postprocess_t2.assert(
    admin.get_text_postprocess_request(c_viewer, c_save) IS NULL,
    'viewer can read an unknown request'
  );

  v_save := admin.save_text_postprocess_draft(
    c_owner, c_save, d_req_save, NULL, NULL, NULL, d_bad, v_bad
  );
  PERFORM text_postprocess_t2.assert(
    (v_save ->> 'action') = 'save' AND (v_save ->> 'replayed') = 'false',
    'first save'
  );
  PERFORM text_postprocess_t2.assert(
    admin.save_text_postprocess_draft(
      c_owner, c_save, d_req_save, NULL, NULL, NULL, d_bad, v_bad
    ) ->> 'replayed' = 'true',
    'same request and digest replays'
  );
  PERFORM text_postprocess_t2.expect_sqlstate(
    format(
      $q$SELECT admin.save_text_postprocess_draft(%L, %L, %L, NULL, NULL, NULL, %L, %L::jsonb)$q$,
      c_owner, c_save, d_req_save_other, d_good, v_good::text
    ),
    'P0001',
    'same request and different digest conflicts'
  );
  PERFORM text_postprocess_t2.assert(
    (admin.get_text_postprocess_request(c_viewer, c_save) ->> 'draft_id') = (v_save ->> 'draft_id'),
    'request lookup returns the committed save'
  );

  PERFORM text_postprocess_t2.expect_sqlstate(
    format(
      $q$SELECT admin.publish_text_postprocess(%L, %L, %L, NULL, %L::timestamptz, %L, %L, %L::jsonb, %L::jsonb)$q$,
      c_owner, c_publish_bad, d_req_publish_bad, v_save ->> 'updated_at', d_bad, v_save ->> 'draft_revision', v_bad::text, text_postprocess_t2.artifact(v_bad)::text
    ),
    '22023',
    'publish rejects duplicate flags'
  );
  PERFORM text_postprocess_t2.assert(
    (SELECT count(*) FROM app_core.text_postprocess_versions) = 0,
    'rejected publish writes no snapshot'
  );

  v_save := admin.save_text_postprocess_draft(
    c_owner,
    c_save_replay,
    d_req_save,
    NULL,
    (v_save ->> 'updated_at')::timestamptz,
    d_bad,
    d_good,
    v_good
  );
  PERFORM text_postprocess_t2.expect_sqlstate(format(
    $q$SELECT admin.publish_text_postprocess(%L,%L,%L,NULL,%L::timestamptz,%L,%L,%L::jsonb,NULL)$q$,
    c_owner,c_publish,d_req_publish,v_save->>'updated_at',d_good,v_save->>'draft_revision',v_good::text),
    '22023','publish missing artifact leaves all state unchanged');
  PERFORM text_postprocess_t2.assert((SELECT count(*) FROM app_core.text_postprocess_versions)=0
    AND NOT EXISTS(SELECT 1 FROM app_core.runtime_config WHERE key='miniapp_text_postprocess_config')
    AND NOT EXISTS(SELECT 1 FROM admin.config_releases WHERE config_key='miniapp_text_postprocess_config')
    AND admin.get_text_postprocess_request(c_owner,c_publish) IS NULL
    AND (SELECT status FROM admin.config_drafts WHERE id=(v_save->>'draft_id')::uuid)='draft','missing artifact publish is atomic');
  v_publish := admin.publish_text_postprocess(
    c_owner,
    c_publish,
    d_req_publish,
    NULL,
    (v_save ->> 'updated_at')::timestamptz,
    d_good,
    v_save ->> 'draft_revision', v_good, text_postprocess_t2.artifact(v_good)
  );
  PERFORM text_postprocess_t2.assert(
    (v_publish ->> 'version') = '1'
      AND (v_publish ->> 'replayed') = 'false'
      AND (SELECT count(*) FROM app_core.text_postprocess_versions) = 1
      AND (SELECT version FROM app_core.runtime_config WHERE key = 'miniapp_text_postprocess_config') = 1
      AND (SELECT count(*) FROM admin.config_releases WHERE config_key = 'miniapp_text_postprocess_config') = 1
      AND (SELECT count(*) FROM admin.audit_logs WHERE request_id = c_publish) = 1
      AND (SELECT status FROM admin.config_drafts WHERE id = (v_save ->> 'draft_id')::uuid) = 'published',
    'publish writes snapshot, runtime, release, audit, and draft status'
  );
  -- SQL 只校验结构和容量。模板里的 script 文本不是 AST 放行证明。
  PERFORM text_postprocess_t2.assert(
    (SELECT source -> 'rules' -> 0 ->> 'replacement'
     FROM app_core.text_postprocess_versions WHERE version = 1) = '<p>script</p>',
    'published snapshot keeps the saved source'
  );
  PERFORM text_postprocess_t2.assert(
    (admin.publish_text_postprocess(
      c_owner, c_publish, d_req_publish, NULL,
      (v_save ->> 'updated_at')::timestamptz, d_good, v_save ->> 'draft_revision', v_good, text_postprocess_t2.artifact(v_good)
    ) ->> 'replayed') = 'true'
      AND (SELECT count(*) FROM app_core.text_postprocess_versions) = 1,
    'publish replay does not create another version'
  );

  PERFORM text_postprocess_t2.assert(
    (SELECT artifact FROM app_core.text_postprocess_versions WHERE version=1) = text_postprocess_t2.artifact(v_good), 'artifact atomically persisted');
  PERFORM text_postprocess_t2.expect_sqlstate(format(
    $q$SELECT admin.publish_text_postprocess(%L,%L,%L,NULL,%L::timestamptz,%L,%L,%L::jsonb,%L::jsonb)$q$,
    c_owner,c_publish,d_req_publish,v_save->>'updated_at',d_good,v_save->>'draft_revision',v_good::text,
    jsonb_set(text_postprocess_t2.artifact(v_good),'{rules,0,tree,0,text}','"different"'::jsonb)::text),
    'P0001','same source and caller digest but different artifact conflicts');
  PERFORM text_postprocess_t2.assert(to_regprocedure('admin.publish_text_postprocess(uuid,uuid,text,integer,timestamptz,text,text)') IS NULL
    AND to_regprocedure('admin.rollback_text_postprocess(uuid,uuid,text,integer,integer)') IS NULL, 'old overloads removed');
  PERFORM text_postprocess_t2.expect_sqlstate('UPDATE app_core.text_postprocess_versions SET artifact=NULL WHERE version=1','55000','artifact cannot be cleared');
  PERFORM text_postprocess_t2.expect_sqlstate('UPDATE app_core.text_postprocess_versions SET artifact=''{}''::jsonb WHERE version=1','55000','artifact cannot be replaced');
  PERFORM text_postprocess_t2.expect_sqlstate('SELECT text_postprocess_t2.overwrite_artifact()','55000','SECURITY DEFINER cannot clear artifact');
  SET LOCAL ROLE postgres;
  PERFORM text_postprocess_t2.expect_sqlstate('UPDATE app_core.text_postprocess_versions SET artifact=NULL WHERE version=1','55000','postgres DML cannot clear artifact');
  PERFORM text_postprocess_t2.expect_sqlstate('TRUNCATE app_core.text_postprocess_versions CASCADE','55000','postgres cannot truncate artifacts');
  RESET ROLE;
  SET LOCAL session_replication_role = replica;
  PERFORM text_postprocess_t2.expect_sqlstate('UPDATE app_core.text_postprocess_versions SET artifact=NULL WHERE version=1','55000','replica session cannot clear artifact');
  PERFORM text_postprocess_t2.expect_sqlstate('TRUNCATE app_core.text_postprocess_versions CASCADE','55000','replica session cannot truncate artifacts');
  SET LOCAL session_replication_role = origin;
  PERFORM admin.text_postprocess_writer_enter();
  PERFORM text_postprocess_t2.expect_sqlstate($q$INSERT INTO app_core.text_postprocess_versions(version,source,schema_version,policy_version,published_at)
    VALUES(99,'{"schema_version":1,"policy_version":1,"rules":[]}',1,1,now())$q$,'23514','writer guard cannot insert missing artifact');
  BEGIN
    SET LOCAL ROLE service_role;
    UPDATE app_core.text_postprocess_versions SET artifact=NULL WHERE version=1;
    RAISE EXCEPTION 'service_role cleared artifact';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  PERFORM text_postprocess_t2.expect_sqlstate(
    format($q$SELECT admin.publish_config_draft(%L::uuid)$q$, v_save ->> 'draft_id'),
    '42501',
    'generic publish cannot bypass the dedicated RPC'
  );
  PERFORM text_postprocess_t2.expect_sqlstate(
    format(
      $q$SELECT admin.upsert_config_draft('test', 'miniapp_text_postprocess_config', %L::jsonb, NULL, NULL)$q$,
      v_good::text
    ),
    '42501',
    'generic upsert cannot write the text-postprocess key'
  );
  PERFORM text_postprocess_t2.assert(
    (
      admin.upsert_config_draft(
        'test', 'system_instructions', '{"ok":true}'::jsonb, NULL, 'other key'
      )
    ).config_key = 'system_instructions',
    'generic upsert still writes another key'
  );

  -- 专用 RPC 的写保护只活在当前事务。该场景函数把多次 RPC 放进同一事务，显式
  -- 清掉事务本地设置以模拟下一条独立请求，再验证直接写仍被拒绝。
  DROP TABLE IF EXISTS pg_temp.text_postprocess_writer_guard;
  PERFORM pg_catalog.set_config('admin.text_postprocess_writer_guard', 'off', true);
  PERFORM text_postprocess_t2.expect_sqlstate(
    $q$INSERT INTO app_core.text_postprocess_versions (version, source, schema_version, policy_version, published_at)
      VALUES (99, '{"schema_version":1,"policy_version":1,"rules":[]}'::jsonb, 1, 1, now())$q$,
    '42501',
    'direct snapshot insert is rejected'
  );
  PERFORM text_postprocess_t2.expect_sqlstate(
    $q$UPDATE app_core.text_postprocess_versions SET policy_version = policy_version WHERE version = 1$q$,
    '55000',
    'snapshot update is rejected'
  );
  PERFORM text_postprocess_t2.expect_sqlstate(
    $q$INSERT INTO app_core.runtime_config (key, value, description, version, updated_at, text_value)
      VALUES ('miniapp_text_postprocess_config', '{}'::jsonb, 'x', 9, now(), NULL)$q$,
    '42501',
    'direct runtime write is rejected'
  );

  SELECT published_at INTO v_old_published
  FROM app_core.text_postprocess_versions WHERE version = 1;
  v_save := admin.save_text_postprocess_draft(
    c_owner, c_save_conflict, d_req_save, 1, NULL, NULL, d_next, v_next
  );
  PERFORM text_postprocess_t2.expect_sqlstate(format(
    $q$SELECT admin.rollback_text_postprocess(%L,%L,%L,1,1,%L::jsonb,NULL)$q$,
    c_owner,c_rollback,d_req_rollback,v_good::text),'22023','rollback requires own artifact');
  PERFORM text_postprocess_t2.assert((SELECT count(*) FROM app_core.text_postprocess_versions)=1
    AND (SELECT version FROM app_core.runtime_config WHERE key='miniapp_text_postprocess_config')=1
    AND admin.get_text_postprocess_request(c_owner,c_rollback) IS NULL,'failed rollback creates no snapshot');
  v_rollback := admin.rollback_text_postprocess(c_owner, c_rollback, d_req_rollback, 1, 1, v_good, text_postprocess_t2.artifact(v_good));
  PERFORM text_postprocess_t2.assert(
    (v_rollback ->> 'version') = '2'
      AND (v_rollback ->> 'target_version') = '1'
      AND (SELECT published_at FROM app_core.text_postprocess_versions WHERE version = 1) = v_old_published
      AND (SELECT source FROM app_core.text_postprocess_versions WHERE version = 2)
          = (SELECT source FROM app_core.text_postprocess_versions WHERE version = 1)
      AND (SELECT artifact FROM app_core.text_postprocess_versions WHERE version=2) = text_postprocess_t2.artifact(v_good)
      AND (SELECT version FROM app_core.runtime_config WHERE key = 'miniapp_text_postprocess_config') = 2,
    'rollback creates a new snapshot and leaves the old row unchanged'
  );
  PERFORM text_postprocess_t2.expect_sqlstate(
    format(
      $q$SELECT admin.publish_text_postprocess(%L, %L, %L, 1, %L::timestamptz, %L, %L, %L::jsonb, %L::jsonb)$q$,
      c_owner, '00000000-0000-4000-8000-00000000010b', repeat('71', 32),
      v_save ->> 'updated_at', d_next, v_save ->> 'draft_revision', v_next::text, text_postprocess_t2.artifact(v_next)::text
    ),
    '40001',
    'publish after rollback does not overwrite with a stale runtime version'
  );

  v_discard := admin.discard_text_postprocess_draft(
    c_owner,
    c_discard,
    d_req_discard,
    (v_save ->> 'updated_at')::timestamptz,
    d_next
  );
  PERFORM text_postprocess_t2.assert(
    (v_discard ->> 'action') = 'discard'
      AND NOT EXISTS (
        SELECT 1 FROM admin.config_drafts
        WHERE config_key = 'miniapp_text_postprocess_config' AND status = 'draft'
      ),
    'discard removes the active draft'
  );
  PERFORM text_postprocess_t2.assert(
    (admin.discard_text_postprocess_draft(
      c_owner, c_discard, d_req_discard, (v_save ->> 'updated_at')::timestamptz, d_next
    ) ->> 'replayed') = 'true',
    'discard replay succeeds after the draft is gone'
  );

  v_version_count := (SELECT count(*) FROM app_core.text_postprocess_versions);
  CREATE TRIGGER zzz_text_postprocess_t2_fail_audit
    BEFORE INSERT ON admin.audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION text_postprocess_t2.fail_audit();
  BEGIN
    CREATE TEMP TABLE text_postprocess_t2_fail_audit (id integer);
    PERFORM admin.rollback_text_postprocess(c_owner, c_audit_fail, d_req_audit, 2, 1, v_good, text_postprocess_t2.artifact(v_good));
    RAISE EXCEPTION 'T2 scenario failed: injected audit failure did not fire';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%injected audit failure%' THEN
      RAISE;
    END IF;
  END;
  DROP TRIGGER zzz_text_postprocess_t2_fail_audit ON admin.audit_logs;
  PERFORM text_postprocess_t2.assert(
    (SELECT count(*) FROM app_core.text_postprocess_versions) = v_version_count
      AND admin.get_text_postprocess_request(c_owner, c_audit_fail) IS NULL,
    'audit failure rolls back the snapshot and leaves the request unknown'
  );

  INSERT INTO experience.chat_sessions (id, user_id)
  VALUES (c_session, c_user), (c_session_null, c_user);

  v_hook := (SELECT hook_calls FROM experience.chat_sessions WHERE id = c_session);
  PERFORM text_postprocess_t2.expect_sqlstate(
    format(
      $q$SELECT experience.start_chat_history_turn_with_postprocess(%L, 'hello', 'model', 99, 120, 75, 50)$q$,
      c_session
    ),
    'P0002',
    'unknown version does not start a turn'
  );
  PERFORM text_postprocess_t2.assert(
    (SELECT hook_calls FROM experience.chat_sessions WHERE id = c_session) = v_hook
      AND (SELECT count(*) FROM experience.chat_history WHERE session_id = c_session) = 0,
    'rejected version leaves no history row'
  );

  v_started := experience.start_chat_history_turn(c_session, 'hello', 'model', 120, 3, 50);
  PERFORM text_postprocess_t2.assert(
    (SELECT postprocess_version FROM experience.chat_history WHERE id = (v_started ->> 'history_id')::uuid) IS NULL
      AND (SELECT context_window_start_turn FROM experience.chat_sessions WHERE id = c_session) = 9,
    'old turn RPC keeps a null version and its own watermark'
  );
  UPDATE experience.chat_history
  SET status = 'success'
  WHERE id = (v_started ->> 'history_id')::uuid;

  v_started := experience.start_chat_history_turn_with_postprocess(
    c_session_null, 'hello', 'model', NULL, 120, 75, 50
  );
  PERFORM text_postprocess_t2.assert(
    (v_started ->> 'postprocess_version') IS NULL
      AND (SELECT postprocess_version FROM experience.chat_history WHERE id = (v_started ->> 'history_id')::uuid) IS NULL
      AND (SELECT hook_calls FROM experience.chat_sessions WHERE id = c_session_null) = 1,
    'null wrapper version stays null and still calls the old RPC'
  );

  v_started := experience.start_chat_history_turn_with_postprocess(
    c_session, 'next', 'model', 1, 120, 75, 50
  );
  v_old_version := (
    SELECT postprocess_version FROM experience.chat_history WHERE id = (v_started ->> 'history_id')::uuid
  );
  PERFORM text_postprocess_t2.assert(
    v_old_version = 1
      AND (v_started ->> 'postprocess_version') = '1'
      AND (SELECT hook_calls FROM experience.chat_sessions WHERE id = c_session) = 2,
    'wrapper binds the published version through the old turn RPC'
  );
  UPDATE experience.chat_history SET status = 'success' WHERE session_id = c_session;

  v_started := experience.start_chat_history_regeneration_with_postprocess(
    c_session, NULL, 'model', 2, 120, 75, 1
  );
  v_new_version := (
    SELECT postprocess_version FROM experience.chat_history WHERE id = (v_started ->> 'history_id')::uuid
  );
  PERFORM text_postprocess_t2.assert(
    v_new_version = 2
      AND v_old_version = 1
      AND (v_started ->> 'user_content') = 'next'
      AND (SELECT context_window_start_turn FROM experience.chat_sessions WHERE id = c_session) = 8
      AND (
        SELECT postprocess_version
        FROM experience.current_chat_history
        WHERE session_id = c_session
          AND turn_index = (v_started ->> 'turn_index')::integer
      ) = 2,
    'regeneration wrapper binds the new revision and delegates the watermark'
  );
  PERFORM text_postprocess_t2.assert(
    NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'experience'
        AND table_name = 'current_chat_history'
        AND column_name = 'billing_only'
    ),
    'view did not absorb a base-table column that was outside its original list'
  );

  PERFORM text_postprocess_t2.expect_sqlstate(
    format(
      $q$SELECT experience.start_chat_history_turn_with_postprocess(%L, 'again', 'model', 1, 120, 75, 50)$q$,
      c_session
    ),
    '55000',
    'wrapper preserves the old RPC busy-session rejection'
  );

  BEGIN
    SET LOCAL ROLE service_role;
    UPDATE experience.chat_history
    SET postprocess_version = 1
    WHERE id = (v_started ->> 'history_id')::uuid;
    RAISE EXCEPTION 'T2 scenario failed: service role rewrote postprocess_version';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    SET LOCAL ROLE service_role;
    UPDATE experience.chat_history
    SET postprocess_version = NULL
    WHERE id = (v_started ->> 'history_id')::uuid;
    RAISE EXCEPTION 'T2 scenario failed: service role cleared postprocess_version';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  PERFORM text_postprocess_t2.assert(
    (SELECT postprocess_version
     FROM experience.chat_history
     WHERE id = (v_started ->> 'history_id')::uuid) = 2,
    'failed direct writes leave the bound version unchanged'
  );

  ALTER TABLE app_core.text_postprocess_versions
    DISABLE TRIGGER trg_text_postprocess_versions_immutable;
  BEGIN
    DELETE FROM app_core.text_postprocess_versions WHERE version = 1;
    RAISE EXCEPTION 'T2 scenario failed: referenced snapshot delete succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
  ALTER TABLE app_core.text_postprocess_versions
    ENABLE ALWAYS TRIGGER trg_text_postprocess_versions_immutable;

  BEGIN
    SET LOCAL ROLE anon;
    PERFORM admin.get_text_postprocess_request(c_owner, c_save);
    RAISE EXCEPTION 'T2 scenario failed: anon executed the request lookup';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  RETURN 'ok';
END;
$fn$;
