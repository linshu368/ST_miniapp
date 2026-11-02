-- domain: app_core creator publication. No new tables or changes to grants/chat snapshots.
-- A server-produced, strictly validated AI approval publishes the exact CAS-bound card version.
-- Legacy callers without a review remain pending; existing pending submissions are NOT approved.
-- Local implementation only; manual TEST/Production execution requires a later release review.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $review_gate$
DECLARE definition text;
 old_block text := $old$   IF r.visibility='public' THEN
     r.state:='ready'; r.review_status:='pending'; r.review_message:=NULL;
     r.submitted_revision:=next_revision;
     r.submission:=jsonb_build_object('draft',r.draft,'runtime',r.draft_runtime,'cover_asset_id',r.cover_asset_id);
   ELSE
     r.review_status:='not_submitted'; r.review_message:=NULL; r.submitted_revision:=NULL; r.submission:=NULL;
     -- Reopening a private card requires a fresh approval, even if it was public before.
     r.approved_revision:=NULL;
   END IF;
   -- First public submission gets runtime for owner trial. It is NOT discoverable until approved.
   -- Published public edits keep their old runtime; a visibility-only unlisting also keeps it.
   IF (p_action='publish' AND r.visibility='private') OR r.published_revision IS NULL THEN
     UPDATE app_core.characters SET name=r.draft_runtime->>'name',description=r.draft_runtime->>'description',
       first_mes=r.draft_runtime->>'first_mes',system_prompt=r.draft_runtime->>'system_prompt',tags=r.draft->'tags',
       avatar_url=CASE WHEN r.cover_asset_id IS NULL THEN '' ELSE 'creator-cover:'||r.cover_asset_id::text END,
       updated_at=now() WHERE id=p_character_id;
     r.state:='ready'; r.published_revision:=next_revision; r.approved_revision:=NULL;
   END IF;$old$;
 new_block text := $new$   IF r.visibility='public' THEN
     r.state:='ready'; r.review_status:='pending'; r.review_message:=NULL;
     r.submitted_revision:=next_revision;
     r.submission:=jsonb_build_object('draft',r.draft,'runtime',r.draft_runtime,'cover_asset_id',r.cover_asset_id);
     -- Only the trusted backend may attach a validated AI result. Old backends keep pending.
     IF p_payload ? 'review' THEN
       IF jsonb_typeof(p_payload->'review') IS DISTINCT FROM 'object' THEN
         RAISE EXCEPTION 'invalid creator review result' USING ERRCODE='22023';
       END IF;
       IF (SELECT count(*) FROM jsonb_object_keys(p_payload->'review'))<>2
         OR jsonb_typeof(p_payload->'review'->'approved') IS DISTINCT FROM 'boolean'
         OR p_payload->'review'->'approved'<>'true'::jsonb
         OR jsonb_typeof(p_payload->'review'->'reason') IS DISTINCT FROM 'string'
         OR btrim(p_payload->'review'->>'reason')=''
         OR char_length(p_payload->'review'->>'reason')>1000 THEN
         RAISE EXCEPTION 'invalid creator review result' USING ERRCODE='22023';
       END IF;
       r.review_status:='approved'; r.approved_revision:=next_revision;
       r.submission:=r.submission||jsonb_build_object('review',p_payload->'review');
     END IF;
   ELSE
     r.review_status:='not_submitted'; r.review_message:=NULL; r.submitted_revision:=NULL; r.submission:=NULL;
     r.approved_revision:=NULL;
   END IF;
   -- AI-reviewed publication updates only the card; existing conversation snapshots stay immutable.
   IF (r.visibility='public' AND r.review_status='approved')
     OR (p_action='publish' AND r.visibility='private') OR r.published_revision IS NULL THEN
     UPDATE app_core.characters SET name=r.draft_runtime->>'name',description=r.draft_runtime->>'description',
       first_mes=r.draft_runtime->>'first_mes',system_prompt=r.draft_runtime->>'system_prompt',tags=r.draft->'tags',
       avatar_url=CASE WHEN r.cover_asset_id IS NULL THEN '' ELSE 'creator-cover:'||r.cover_asset_id::text END,
       last_listed_at=CASE WHEN r.visibility='public' AND r.review_status='approved'
         AND (SELECT approved_revision IS NULL FROM app_core.character_creations WHERE character_id=p_character_id)
         THEN now() ELSE last_listed_at END,
       updated_at=now() WHERE id=p_character_id;
     r.state:='ready'; r.published_revision:=next_revision;
     IF r.visibility='private' OR r.review_status<>'approved' THEN r.approved_revision:=NULL; END IF;
   END IF;$new$;
BEGIN
 definition:=pg_get_functiondef('app_core.mutate_creator_character(uuid,uuid,text,integer,jsonb)'::regprocedure);
 IF strpos(definition,'-- AI-reviewed publication')=0 THEN
   IF strpos(definition,old_block)=0 OR strpos(definition,$old_identity$p_payload-'runtime'$old_identity$)=0 THEN
     RAISE EXCEPTION 'Creator publication shape changed; inspect before applying';
   END IF;
   definition:=replace(definition,old_block,new_block);
   -- Approval/reason is server output, not a new client intent. Exact retries preserve the result.
   definition:=replace(definition,$old_identity$p_payload-'runtime'$old_identity$,
     $new_identity$p_payload-'runtime'-'review'$new_identity$);
   EXECUTE definition;
 END IF;
END $review_gate$;
COMMIT;
NOTIFY pgrst,'reload schema';
