-- Opt-in synthetic benchmark in the disposable PG17 harness only.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='180s';
CREATE TEMP TABLE display_benchmark_sessions(turns integer,id uuid PRIMARY KEY);
CREATE TEMP TABLE display_benchmark_samples(turns integer,variant text,ms double precision);
DO $fixture$
DECLARE n integer; sid uuid; owner_id uuid; character uuid; payload jsonb; batch uuid[];
BEGIN
 SELECT user_id,character_id INTO owner_id,character FROM experience.chat_sessions LIMIT 1;
 payload:=jsonb_build_array(jsonb_build_object('role','system','content','','request_id','synthetic-exact'),
   jsonb_build_object('role','assistant','content','synthetic opening'),
   jsonb_build_object('role','user','content',repeat('synthetic prompt ',8192)));
 -- Fixture construction is not an admission benchmark. Avoid quadratic stats work
 -- while bulk-loading historical rows; restore all triggers before measuring reads.
 ALTER TABLE experience.chat_history DISABLE TRIGGER USER;
 FOREACH n IN ARRAY ARRAY[10,100,1000,10000] LOOP
   INSERT INTO experience.chat_sessions(user_id,character_id,title) VALUES(owner_id,character,'benchmark') RETURNING id INTO sid;
   INSERT INTO display_benchmark_sessions VALUES(n,sid);
   INSERT INTO experience.chat_history(user_id,model,user_input,assistant_reply,history,character_id,session_id,turn_index,revision,status)
     SELECT owner_id,'synthetic','question-'||i,'answer-'||i,payload,character,sid,i,0,'success' FROM generate_series(1,n) i;
   INSERT INTO experience.chat_history(user_id,model,user_input,assistant_reply,history,character_id,session_id,turn_index,revision,status)
     SELECT owner_id,'synthetic','question-'||n,'revised-'||i,payload,character,sid,n,i,'success' FROM generate_series(1,3) i;
 END LOOP;
 ALTER TABLE experience.chat_history ENABLE TRIGGER USER;
 -- Precomputed known values model completed backfill, without timing fixture setup.
 INSERT INTO experience.chat_history_display_metadata(history_id,request_id,opening_message,projection_version)
   SELECT h.id,'synthetic-exact','synthetic opening',1 FROM experience.chat_history h JOIN display_benchmark_sessions s ON s.id=h.session_id;
END;
$fixture$;
ANALYZE experience.chat_history;
ANALYZE experience.chat_history_display_metadata;
ANALYZE experience.chat_sessions;
DO $measure$
DECLARE s record; i integer; t timestamptz; owner_id uuid; result jsonb; boundary integer; seen integer; count_page integer; legacy_ms double precision:=0;
BEGIN
 FOR s IN SELECT * FROM display_benchmark_sessions ORDER BY turns LOOP
   SELECT user_id INTO owner_id FROM experience.chat_sessions WHERE id=s.id;
   legacy_ms:=0;
   RAISE NOTICE 'measuring % turns (128 KiB prompt)',s.turns;
   -- Warm up both read paths, then alternate 100 paired samples.
   FOR i IN 0..100 LOOP
     t:=clock_timestamp();
     SELECT jsonb_agg(to_jsonb(p)) INTO result FROM experience.list_chat_message_page(owner_id,s.id,NULL,25) p;
     IF i>0 THEN INSERT INTO display_benchmark_samples VALUES(s.turns,'projected_page',(extract(epoch FROM clock_timestamp()-t)*1000)); END IF;
     -- Stop repeating a pathological baseline after the first >200ms sample.
     -- Its sample count is reported honestly; never call that a 100-sample P95.
     IF legacy_ms<=200 THEN
       t:=clock_timestamp();
       SELECT jsonb_agg(to_jsonb(p)) INTO result FROM (
       SELECT id,turn_index,user_input,assistant_reply,history->0 AS head0,history->1 AS head1
       FROM experience.session_chat_history WHERE session_id=s.id ORDER BY turn_index DESC LIMIT 26
       ) p;
       legacy_ms:=extract(epoch FROM clock_timestamp()-t)*1000;
       IF i>0 OR legacy_ms>200 THEN INSERT INTO display_benchmark_samples VALUES(s.turns,'legacy_head_page',legacy_ms); END IF;
     END IF;
   END LOOP;
   -- Exercise every page including the earliest boundary, not only the last page.
   boundary:=NULL; seen:=0;
   LOOP
     SELECT count(*),min(turn_index) INTO count_page,boundary FROM (
       SELECT turn_index FROM experience.list_chat_message_page(owner_id,s.id,boundary,25) LIMIT 25
     ) page;
     seen:=seen+count_page;
     EXIT WHEN count_page<25;
   END LOOP;
   IF seen<>s.turns THEN RAISE EXCEPTION 'long-history completeness failed: %/%',seen,s.turns; END IF;
 END LOOP;
END;
$measure$;
DO $writes$
DECLARE s record; i integer; variant text; t timestamptz; owner_id uuid; character uuid; hid uuid;
  input jsonb; prompt jsonb; charge uuid; request_id uuid;
BEGIN
 FOR s IN SELECT * FROM display_benchmark_sessions ORDER BY turns LOOP
   SELECT user_id,character_id INTO owner_id,character FROM experience.chat_sessions WHERE id=s.id;
   FOR i IN 1..100 LOOP
     FOREACH variant IN ARRAY ARRAY['baseline','projection'] LOOP
       charge:=gen_random_uuid(); request_id:=gen_random_uuid();
       INSERT INTO experience.chat_history(user_id,model,user_input,character_id,session_id,turn_index,revision,status)
       VALUES(owner_id,'synthetic','synthetic',character,s.id,s.turns+i,CASE WHEN variant='baseline' THEN 0 ELSE 1 END,'streaming') RETURNING id INTO hid;
       input:=jsonb_build_object('request_id',request_id,'primary_attempt_id',gen_random_uuid(),
         'mode','send','received_at',clock_timestamp(),'requested_model_id','synthetic',
         'provider','openrouter','model','synthetic','catalog_version',1,'timeout_ms',4000,
         'deadline_ms',6000,'timeout_rate_target',0.05,'charge_id',charge,
         'history',jsonb_build_array(jsonb_build_object('role','system','content','','request_id',request_id)));
       prompt:=(input->'history')||jsonb_build_array(jsonb_build_object('role','assistant','content','opening'),jsonb_build_object('role','user','content',repeat('synthetic prompt ',8192)));
       t:=clock_timestamp();
       IF variant='baseline' THEN
         PERFORM experience.benchmark_baseline_admission(hid,input);
         PERFORM experience.benchmark_baseline_admission(hid,input||jsonb_build_object('history',prompt,'snapshot',jsonb_build_object('charge_id',charge)));
       ELSE
         PERFORM experience.begin_chat_generation_observation(hid,input);
         PERFORM experience.begin_chat_generation_observation(hid,input||jsonb_build_object('history',prompt,'snapshot',jsonb_build_object('charge_id',charge)));
       END IF;
       INSERT INTO display_benchmark_samples VALUES(s.turns,variant||'_admit_freeze',extract(epoch FROM clock_timestamp()-t)*1000);
       t:=clock_timestamp();
       UPDATE experience.chat_history SET status='success',assistant_reply='synthetic final reply' WHERE id=hid;
       INSERT INTO display_benchmark_samples VALUES(s.turns,variant||'_terminal_stats',extract(epoch FROM clock_timestamp()-t)*1000);
     END LOOP;
   END LOOP;
 END LOOP;
END;
$writes$;
SELECT turns,variant,count(*) AS samples,
 round(percentile_cont(0.50) WITHIN GROUP(ORDER BY ms)::numeric,3) AS p50_ms,
 CASE WHEN count(*)>=100 THEN round(percentile_cont(0.95) WITHIN GROUP(ORDER BY ms)::numeric,3) END AS p95_ms,
 round(max(ms)::numeric,3) AS max_ms
FROM display_benchmark_samples GROUP BY turns,variant ORDER BY turns,variant;
-- Print a representative plan for the narrow indexed candidate selection.
EXPLAIN (ANALYZE,BUFFERS) SELECT turn_index FROM experience.chat_history
 WHERE session_id=(SELECT id FROM display_benchmark_sessions WHERE turns=10000)
   AND turn_index IS NOT NULL AND revision IS NOT NULL
 GROUP BY turn_index ORDER BY turn_index DESC LIMIT 26;
ROLLBACK;
