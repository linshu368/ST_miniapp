\set ON_ERROR_STOP 1
-- Isolated fixtures: one user, one character, two sessions.
INSERT INTO app_core.users VALUES ('a1000000-0000-4000-8000-000000000001');
INSERT INTO app_core.characters VALUES ('a2000000-0000-4000-8000-000000000001');
INSERT INTO experience.chat_sessions (id, user_id, character_id, title) VALUES
 ('a0000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001','源'),
 ('a0000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001','空');

-- 12 completed turns through the real turn RPC, passing tiny old watermarks that must now be ignored.
DO $$
DECLARE i integer; s uuid := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  FOR i IN 1..12 LOOP
    PERFORM experience.start_chat_history_turn(s, 'u' || i, 'm', 120, 1, 1);
    UPDATE experience.chat_history SET status='success', assistant_reply='a' || i
    WHERE session_id=s AND turn_index=i;
  END LOOP;
  PERFORM experience.start_chat_history_turn('a0000000-0000-4000-8000-000000000002', 'x', 'm', 120, 1, 1);
  UPDATE experience.chat_history SET status='success', assistant_reply='y'
  WHERE session_id='a0000000-0000-4000-8000-000000000002';
  IF (SELECT context_window_start_turn FROM experience.chat_sessions WHERE id=s) <> 1 THEN
    RAISE EXCEPTION 'old turn-count flood still moved the window';
  END IF;
  IF to_regprocedure('experience.apply_context_window_flood(uuid,integer,integer,integer,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'flood function still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM app_core.runtime_config WHERE key IN ('max_context_turns','retain_context_turns')) THEN
    RAISE EXCEPTION 'old window config keys still present';
  END IF;
  -- Regeneration path is patched too.
  PERFORM experience.start_chat_history_regeneration(s, NULL, 'm', 120, 1, 1);
  UPDATE experience.chat_history SET status='success', assistant_reply='a12b'
  WHERE session_id=s AND turn_index=12 AND status='streaming';
  IF (SELECT context_window_start_turn FROM experience.chat_sessions WHERE id=s) <> 1 THEN
    RAISE EXCEPTION 'regeneration still floods';
  END IF;
END $$;

-- advance + job, CAS on the observed start
DO $$
DECLARE s uuid := 'a0000000-0000-4000-8000-000000000001'; j experience.story_memory_jobs%ROWTYPE;
BEGIN
  IF NOT experience.advance_story_memory_window(s, 1, 6, 5) THEN RAISE EXCEPTION 'advance failed'; END IF;
  IF experience.advance_story_memory_window(s, 1, 7, 6) THEN RAISE EXCEPTION 'stale advance applied'; END IF;
  SELECT * INTO j FROM experience.story_memory_jobs WHERE session_id=s;
  IF j.status <> 'pending' OR j.attempts <> 0 OR j.target_end <> 5 THEN
    RAISE EXCEPTION 'job not pending after advance';
  END IF;
  BEGIN
    PERFORM experience.advance_story_memory_window(s, 6, 5, 5);
    RAISE EXCEPTION 'backward advance accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END $$;

-- claim / lease / CAS commit / finish
DO $$
DECLARE s uuid := 'a0000000-0000-4000-8000-000000000001'; c jsonb; f jsonb; v integer;
BEGIN
  c := experience.claim_story_memory_jobs('w1', 5, 600);
  IF jsonb_array_length(c) <> 1 OR (c->0->>'target_end')::int <> 5 OR (c->0->>'covered_end_turn')::int <> 0
     OR c->0->'memory_content' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'unexpected claim %', c;
  END IF;
  IF jsonb_array_length(experience.claim_story_memory_jobs('w2', 5, 600)) <> 0 THEN
    RAISE EXCEPTION 'running job double-claimed';
  END IF;
  BEGIN
    PERFORM experience.commit_story_memory_version(s,'w2',0,3,'x',NULL,NULL,NULL,NULL,600);
    RAISE EXCEPTION 'foreign worker committed';
  EXCEPTION WHEN SQLSTATE 'P0409' THEN NULL;
  END;
  BEGIN
    PERFORM experience.commit_story_memory_version(s,'w1',0,6,'x',NULL,NULL,NULL,NULL,600);
    RAISE EXCEPTION 'coverage beyond target accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  v := experience.commit_story_memory_version(s,'w1',0,3,'甲出场 (T1-T3)',  'v1','m',10,5,600);
  IF v <> 1 THEN RAISE EXCEPTION 'first version %', v; END IF;
  BEGIN
    PERFORM experience.commit_story_memory_version(s,'w1',0,5,'y',NULL,NULL,NULL,NULL,600);
    RAISE EXCEPTION 'stale expected coverage accepted';
  EXCEPTION WHEN SQLSTATE 'P0409' THEN NULL;
  END;
  v := experience.commit_story_memory_version(s,'w1',3,5,'甲出场 (T1-T3)。乙离开（T4、T5）',  'v1','m',10,5,600);
  -- Target raised while running: running stays, finish turns it back to pending.
  IF NOT experience.advance_story_memory_window(s, 6, 9, 8) THEN RAISE EXCEPTION 'advance while running failed'; END IF;
  IF (SELECT status FROM experience.story_memory_jobs WHERE session_id=s) <> 'running' THEN
    RAISE EXCEPTION 'advance clobbered a running job';
  END IF;
  f := experience.finish_story_memory_job(s, 'w1', NULL, 1, 5);
  IF f->>'status' <> 'pending' THEN RAISE EXCEPTION 'finish should re-pend: %', f; END IF;

  c := experience.claim_story_memory_jobs('w1', 5, 600);
  v := experience.commit_story_memory_version(s,'w1',5,8,'甲乙丙 (T1-T8)', 'v1','m',NULL,NULL,600);
  f := experience.finish_story_memory_job(s, 'w1', NULL, 6, 8);
  IF f->>'status' <> 'idle' OR v <> 3 THEN RAISE EXCEPTION 'finish should idle: % v=%', f, v; END IF;
END $$;

-- failure backoff and terminal state; next advance revives
DO $$
DECLARE s uuid := 'a0000000-0000-4000-8000-000000000001'; f jsonb; i integer; c jsonb;
BEGIN
  PERFORM experience.advance_story_memory_window(s, 9, 11, 10);
  FOR i IN 1..5 LOOP
    UPDATE experience.story_memory_jobs SET next_attempt_at = now() - interval '1 second' WHERE session_id=s;
    c := experience.claim_story_memory_jobs('w1', 5, 600);
    IF jsonb_array_length(c) <> 1 THEN RAISE EXCEPTION 'retry % not claimable', i; END IF;
    f := experience.finish_story_memory_job(s, 'w1', 'http_500', NULL, NULL);
    IF (f->>'attempts')::int <> i THEN RAISE EXCEPTION 'attempts %', f; END IF;
  END LOOP;
  IF f->>'status' <> 'failed' THEN RAISE EXCEPTION 'should be failed after 5: %', f; END IF;
  IF (SELECT max(version) FROM experience.story_memories WHERE session_id=s) <> 3 THEN
    RAISE EXCEPTION 'failure changed versions';
  END IF;
  -- Re-sending the same target while waiting must not reset backoff or revive.
  PERFORM experience.advance_story_memory_window(s, 11, 11, 10);
  IF (SELECT status || attempts FROM experience.story_memory_jobs WHERE session_id=s) <> 'failed5' THEN
    RAISE EXCEPTION 'same target reset a failed job';
  END IF;
  PERFORM experience.advance_story_memory_window(s, 11, 12, 11);
  IF (SELECT status || attempts FROM experience.story_memory_jobs WHERE session_id=s) <> 'pending0' THEN
    RAISE EXCEPTION 'raised target did not revive failed job';
  END IF;
  -- Expired lease is reclaimable and the old worker loses it.
  c := experience.claim_story_memory_jobs('w1', 5, 600);
  UPDATE experience.story_memory_jobs SET lease_until = now() - interval '1 second' WHERE session_id=s;
  c := experience.claim_story_memory_jobs('w2', 5, 600);
  IF jsonb_array_length(c) <> 1 THEN RAISE EXCEPTION 'expired lease not reclaimed'; END IF;
  IF experience.finish_story_memory_job(s, 'w1', NULL, NULL, NULL)->>'status' <> 'lease_lost' THEN
    RAISE EXCEPTION 'old worker finished a reclaimed job';
  END IF;
  PERFORM experience.finish_story_memory_job(s, 'w2', 'timeout', NULL, NULL);
  IF (SELECT next_attempt_at FROM experience.story_memory_jobs WHERE session_id=s) <= now() THEN
    RAISE EXCEPTION 'failure did not back off';
  END IF;

  -- Compress ahead of the window: request-only call (window stays at 12), target 13.
  IF NOT experience.advance_story_memory_window(s, 12, 12, 13) THEN RAISE EXCEPTION 'request-only failed'; END IF;
  IF (SELECT context_window_start_turn FROM experience.chat_sessions WHERE id=s) <> 12 THEN
    RAISE EXCEPTION 'request-only moved the window';
  END IF;
  c := experience.claim_story_memory_jobs('w3', 5, 600);
  IF jsonb_array_length(c) <> 1 THEN RAISE EXCEPTION 'raised target not immediately due'; END IF;
  PERFORM experience.commit_story_memory_version(s,'w3',8,13,'甲乙丙丁 (T1-T13)','v1','m',NULL,NULL,600);
  IF experience.finish_story_memory_job(s, 'w3', NULL, 9, 13)->>'status' <> 'idle' THEN
    RAISE EXCEPTION 'ahead compression did not complete';
  END IF;
END $$;

-- fork: memory selection by anchor, label stripping, inherited range
DO $$
DECLARE
  s uuid := 'a0000000-0000-4000-8000-000000000001';
  late jsonb; early jsonb; plain jsonb; m record;
BEGIN
  -- Anchor at turn 12 (latest): v4 covers 13 (ahead of the anchor) and is skipped;
  -- newest version ending before the anchor is v3 (covered 8) → inherit 9..12.
  late := experience.fork_chat_session('a1000000-0000-4000-8000-000000000001', s,
    (SELECT id FROM experience.session_chat_history WHERE session_id=s AND turn_index=12),
    'a3000000-0000-4000-8000-000000000001');
  IF (late->>'branch_inherited_turns')::int <> 4 THEN RAISE EXCEPTION 'late inherited %', late->>'branch_inherited_turns'; END IF;
  SELECT * INTO m FROM experience.story_memories WHERE session_id=(late->>'id')::uuid;
  IF m.content <> '甲乙丙' OR m.covered_end_turn <> 0 OR m.version <> 1 THEN
    RAISE EXCEPTION 'late branch memory % %', m.content, m.covered_end_turn;
  END IF;
  IF (SELECT context_window_start_turn FROM experience.chat_sessions WHERE id=(late->>'id')::uuid) <> 1 THEN
    RAISE EXCEPTION 'branch window not reset';
  END IF;
  -- Anchor at turn 4: only v1 (covered 3) ends before it → inherit turn 4 only, no later plot.
  early := experience.fork_chat_session('a1000000-0000-4000-8000-000000000001', s,
    (SELECT id FROM experience.session_chat_history WHERE session_id=s AND turn_index=4),
    'a3000000-0000-4000-8000-000000000002');
  IF (early->>'branch_inherited_turns')::int <> 1 THEN RAISE EXCEPTION 'early inherited %', early->>'branch_inherited_turns'; END IF;
  IF (SELECT content FROM experience.story_memories WHERE session_id=(early->>'id')::uuid) <> '甲出场' THEN
    RAISE EXCEPTION 'early branch picked a memory that covers the anchor';
  END IF;
  -- No memory at all → inherit from turn 1, no memory row.
  plain := experience.fork_chat_session('a1000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000002',
    (SELECT id FROM experience.session_chat_history WHERE session_id='a0000000-0000-4000-8000-000000000002' AND turn_index=1),
    'a3000000-0000-4000-8000-000000000003');
  IF (plain->>'branch_inherited_turns')::int <> 1
     OR EXISTS (SELECT 1 FROM experience.story_memories WHERE session_id=(plain->>'id')::uuid) THEN
    RAISE EXCEPTION 'plain fork wrong';
  END IF;
  IF to_regprocedure('experience.fork_chat_session(uuid,uuid,uuid,uuid,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'old fork signature still exists';
  END IF;
  -- Replay stays idempotent.
  IF experience.fork_chat_session('a1000000-0000-4000-8000-000000000001', s,
    (SELECT id FROM experience.session_chat_history WHERE session_id=s AND turn_index=12),
    'a3000000-0000-4000-8000-000000000001')->>'id' <> late->>'id' THEN
    RAISE EXCEPTION 'fork replay not idempotent';
  END IF;
END $$;

-- soft-deleted session: claim releases it to idle
DO $$
DECLARE s uuid := 'a0000000-0000-4000-8000-000000000002';
BEGIN
  PERFORM experience.advance_story_memory_window(s, 1, 2, 1);
  UPDATE experience.chat_sessions SET deleted_at = now() WHERE id = s;
  IF jsonb_array_length(experience.claim_story_memory_jobs('w9', 5, 600)) <> 0 THEN
    RAISE EXCEPTION 'deleted session claimed';
  END IF;
  IF (SELECT status FROM experience.story_memory_jobs WHERE session_id=s) <> 'idle' THEN
    RAISE EXCEPTION 'deleted session job not idled';
  END IF;
END $$;

-- managed config keys
DO $$
BEGIN
  IF NOT admin.is_managed_config_key('story_memory_config') OR NOT admin.is_managed_config_key('story_memory_prompt')
     OR NOT admin.is_managed_config_key('system_instructions') OR admin.is_managed_config_key('nope') THEN
    RAISE EXCEPTION 'managed key wrapper wrong';
  END IF;
  PERFORM admin.validate_managed_config_value('story_memory_config', '{"enabled":true}'::jsonb, NULL);
  PERFORM admin.validate_managed_config_value('story_memory_prompt', NULL, '## 一\n{{old_memory}}');
  BEGIN
    PERFORM admin.validate_managed_config_value('story_memory_config', NULL, 'text');
    RAISE EXCEPTION 'config accepted text';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM admin.validate_managed_config_value('story_memory_prompt', NULL, repeat('字', 20001));
    RAISE EXCEPTION 'overlong prompt accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  INSERT INTO admin.config_drafts VALUES ('story_memory_config'), ('story_memory_prompt');
  INSERT INTO admin.config_releases VALUES ('story_memory_prompt');
  BEGIN
    INSERT INTO admin.config_drafts VALUES ('nope');
    RAISE EXCEPTION 'unknown key accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF has_table_privilege('authenticated', 'experience.story_memories', 'SELECT')
     OR has_function_privilege('anon', 'experience.claim_story_memory_jobs(text,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'client roles can reach story memory';
  END IF;
END $$;

