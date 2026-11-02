-- domain: app_core. Creator ownership/edit source and durable use grants are character roots.
-- Depends on 20261030_creator_cover_assets.sql; existing app_core users/characters,
-- miniapp_features favorites/socials, experience sessions and admin audit/roles remain authoritative.
-- Apply before application deployment, one file at a time, TEST before production.
-- Rollback: disable creation entry/review writes; retain tables, grants and published character IDs.
-- Existing official cards have no creation row and retain their existing runtime behavior.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app_core.character_creations (
  character_id uuid PRIMARY KEY REFERENCES app_core.characters(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES app_core.users(id) ON DELETE RESTRICT,
  draft jsonb NOT NULL CHECK (jsonb_typeof(draft)='object'),
  draft_runtime jsonb NOT NULL CHECK (jsonb_typeof(draft_runtime)='object'),
  cover_asset_id uuid REFERENCES app_core.character_cover_assets(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','ready')),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  review_status text NOT NULL DEFAULT 'not_submitted' CHECK (review_status IN ('not_submitted','pending','approved','rejected')),
  review_message text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  submitted_revision integer,
  published_revision integer,
  approved_revision integer,
  submission jsonb,
  last_mutation jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX character_creations_owner_updated_idx ON app_core.character_creations(owner_user_id,updated_at DESC);
CREATE INDEX character_creations_review_idx ON app_core.character_creations(updated_at) WHERE review_status='pending';
CREATE TABLE app_core.character_access_grants (
  user_id uuid NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
  character_id uuid NOT NULL REFERENCES app_core.characters(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,character_id)
);
CREATE INDEX character_access_grants_character_idx ON app_core.character_access_grants(character_id);
ALTER TABLE app_core.character_creations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_core.character_access_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_core.character_creations,app_core.character_access_grants FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON app_core.character_creations,app_core.character_access_grants TO service_role;
COMMENT ON TABLE app_core.character_access_grants IS 'Ever successfully opened or favorited a creator character; removing favorite/session never revokes this grant';
COMMENT ON COLUMN app_core.character_creations.approved_revision IS 'Approval of the effective runtime, independent of an edited draft awaiting another review';

CREATE FUNCTION app_core.can_discover_character(p_character_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM app_core.characters c LEFT JOIN app_core.character_creations cr ON cr.character_id=c.id
 WHERE c.id=p_character_id AND c.enabled AND c.archived_at IS NULL
 AND (cr.character_id IS NULL OR (cr.state='ready' AND cr.visibility='public' AND cr.approved_revision IS NOT NULL)))
$$;
CREATE FUNCTION app_core.can_use_character(p_user_id uuid,p_character_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM app_core.characters c LEFT JOIN app_core.character_creations cr ON cr.character_id=c.id
 WHERE c.id=p_character_id AND c.enabled AND c.archived_at IS NULL AND (
 cr.character_id IS NULL OR cr.owner_user_id=p_user_id OR
 (cr.state='ready' AND ((cr.visibility='public' AND cr.approved_revision IS NOT NULL) OR
 EXISTS(SELECT 1 FROM app_core.character_access_grants g WHERE g.character_id=c.id AND g.user_id=p_user_id)))))
$$;

-- The character lock serializes first use/favorite against privacy changes. Eligibility is granted
-- before creating the session so a concurrent unlisting cannot steal an already accepted entry.
CREATE FUNCTION app_core.grant_creator_character_access(p_user_id uuid,p_character_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF p_user_id IS NULL OR p_character_id IS NULL THEN RAISE EXCEPTION 'invalid access' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM app_core.characters WHERE id=p_character_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0404'; END IF;
 IF EXISTS(SELECT 1 FROM app_core.character_creations WHERE character_id=p_character_id) THEN
   IF NOT app_core.can_use_character(p_user_id,p_character_id) THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0404'; END IF;
   INSERT INTO app_core.character_access_grants(user_id,character_id) VALUES(p_user_id,p_character_id) ON CONFLICT DO NOTHING;
 END IF;
END $$;

-- Single atomic owner mutation: character lock -> creation row -> asset read. No browser role can call it.
CREATE FUNCTION app_core.mutate_creator_character(p_user_id uuid,p_character_id uuid,p_action text,p_expected_revision integer,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r app_core.character_creations; next_revision integer; cover uuid; mutation jsonb;
BEGIN
 IF p_user_id IS NULL OR p_character_id IS NULL OR p_action NOT IN ('create','save','publish','visibility') OR p_payload IS NULL THEN
   RAISE EXCEPTION 'invalid creator mutation' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('creator:'||p_character_id::text,0));
 IF p_action='create' THEN
   SELECT * INTO r FROM app_core.character_creations WHERE character_id=p_character_id;
   IF FOUND THEN
     IF r.owner_user_id<>p_user_id THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0404'; END IF;
     RETURN to_jsonb(r);
   END IF;
   IF EXISTS(SELECT 1 FROM app_core.characters WHERE id=p_character_id) THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0404'; END IF;
   IF (SELECT count(*) FROM app_core.character_creations WHERE owner_user_id=p_user_id AND created_at>now()-interval '1 hour')>=30 THEN
     RAISE EXCEPTION 'creation rate limit' USING ERRCODE='P0429';
   END IF;
   cover:=(p_payload->>'cover_asset_id')::uuid;
   IF cover IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_core.character_cover_assets WHERE id=cover AND owner_user_id=p_user_id) THEN
     RAISE EXCEPTION 'cover unavailable' USING ERRCODE='P0404';
   END IF;
   INSERT INTO app_core.characters(id,name,enabled,sort_order) VALUES(p_character_id,'',true,2147483647);
   INSERT INTO app_core.character_creations(character_id,owner_user_id,draft,draft_runtime,cover_asset_id)
   VALUES(p_character_id,p_user_id,p_payload->'draft',p_payload->'runtime',cover) RETURNING * INTO r;
   RETURN to_jsonb(r);
 END IF;
 PERFORM 1 FROM app_core.characters WHERE id=p_character_id FOR UPDATE;
 SELECT * INTO r FROM app_core.character_creations WHERE character_id=p_character_id FOR UPDATE;
 IF NOT FOUND OR r.owner_user_id<>p_user_id THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0404'; END IF;
 -- Idempotency is the client intent. A server preset asset update must not change a replay.
 mutation:=jsonb_build_object('action',p_action,'expected_revision',p_expected_revision,'payload',p_payload-'runtime');
 IF r.last_mutation=mutation THEN RETURN to_jsonb(r); END IF;
 IF p_expected_revision IS NULL OR r.revision<>p_expected_revision THEN RAISE EXCEPTION 'revision conflict' USING ERRCODE='P0409'; END IF;
 next_revision:=r.revision+1;
 IF p_action='save' THEN
   cover:=(p_payload->>'cover_asset_id')::uuid;
   IF cover IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_core.character_cover_assets WHERE id=cover AND owner_user_id=p_user_id) THEN
     RAISE EXCEPTION 'cover unavailable' USING ERRCODE='P0404';
   END IF;
   r.draft:=p_payload->'draft'; r.draft_runtime:=p_payload->'runtime'; r.cover_asset_id:=cover;
   -- Edits invalidate the pending review. Approved runtime itself is intentionally untouched.
   r.review_status:='not_submitted'; r.review_message:=NULL; r.submission:=NULL; r.submitted_revision:=NULL;
 ELSE
   IF p_payload->>'visibility' NOT IN ('private','public') THEN RAISE EXCEPTION 'invalid visibility' USING ERRCODE='22023'; END IF;
   IF p_action='visibility' AND r.state<>'ready' THEN RAISE EXCEPTION 'publish first' USING ERRCODE='22023'; END IF;
   IF p_action='publish' OR p_payload->>'visibility'='public' THEN
     IF r.cover_asset_id IS NULL OR btrim(coalesce(r.draft->>'name',''))='' OR btrim(coalesce(r.draft->>'description',''))=''
       OR btrim(coalesce(r.draft->>'opening',''))='' OR jsonb_array_length(r.draft->'tags')=0
       OR (btrim(coalesce(r.draft->>'background',''))='' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.draft->'backgroundFiles') f WHERE btrim(coalesce(f->>'content',''))<>'')) THEN
       RAISE EXCEPTION 'required fields missing' USING ERRCODE='22023';
     END IF;
   END IF;
   r.visibility:=p_payload->>'visibility';
   IF r.visibility='public' THEN
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
   END IF;
 END IF;
 UPDATE app_core.character_creations SET draft=r.draft,draft_runtime=r.draft_runtime,cover_asset_id=r.cover_asset_id,
 state=r.state,visibility=r.visibility,review_status=r.review_status,review_message=r.review_message,
 revision=next_revision,submitted_revision=r.submitted_revision,published_revision=r.published_revision,
 approved_revision=r.approved_revision,submission=r.submission,last_mutation=mutation,updated_at=now()
 WHERE character_id=p_character_id RETURNING * INTO r;
 RETURN to_jsonb(r);
END $$;

CREATE FUNCTION app_core.review_creator_character(p_admin_user_id uuid,p_character_id uuid,p_submitted_revision integer,p_decision text,p_reason text,p_environment text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r app_core.character_creations; actor admin.admin_users; runtime jsonb; approved_cover uuid;
BEGIN
 SELECT * INTO actor FROM admin.admin_users WHERE user_id=p_admin_user_id AND role IN ('owner','operator');
 IF NOT FOUND OR p_environment NOT IN ('test','production') OR
   (p_environment='production' AND NOT actor.can_access_prod) OR (p_environment='test' AND NOT actor.can_access_test) THEN
   RAISE EXCEPTION 'operator required' USING ERRCODE='42501';
 END IF;
 IF p_decision NOT IN ('approve','reject') OR (p_decision='reject' AND btrim(coalesce(p_reason,''))='') OR char_length(coalesce(p_reason,''))>1000 THEN
   RAISE EXCEPTION 'invalid review' USING ERRCODE='22023';
 END IF;
 PERFORM 1 FROM app_core.characters WHERE id=p_character_id FOR UPDATE;
 SELECT * INTO r FROM app_core.character_creations WHERE character_id=p_character_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0404'; END IF;
 IF r.review_status<>'pending' OR r.submitted_revision IS DISTINCT FROM p_submitted_revision OR r.revision<>p_submitted_revision OR r.visibility<>'public' THEN
   RAISE EXCEPTION 'submission changed' USING ERRCODE='P0409';
 END IF;
 IF p_decision='approve' THEN
   runtime:=r.submission->'runtime'; approved_cover:=(r.submission->>'cover_asset_id')::uuid;
   UPDATE app_core.characters SET name=runtime->>'name',description=runtime->>'description',first_mes=runtime->>'first_mes',
     system_prompt=runtime->>'system_prompt',tags=r.submission->'draft'->'tags',avatar_url='creator-cover:'||approved_cover::text,
     last_listed_at=CASE WHEN r.approved_revision IS NULL THEN now() ELSE last_listed_at END,updated_at=now()
   WHERE id=p_character_id;
   r.published_revision:=p_submitted_revision; r.approved_revision:=p_submitted_revision;
 END IF;
 UPDATE app_core.character_creations SET review_status=CASE WHEN p_decision='approve' THEN 'approved' ELSE 'rejected' END,
   review_message=CASE WHEN p_decision='reject' THEN p_reason ELSE NULL END,
   published_revision=r.published_revision,approved_revision=r.approved_revision,revision=revision+1,last_mutation=NULL,updated_at=now()
 WHERE character_id=p_character_id RETURNING * INTO r;
 INSERT INTO admin.audit_logs(actor_user_id,actor_email,environment,action,schema_name,table_name,record_id,after_value)
 VALUES(actor.user_id,actor.email,p_environment,'character.creator.'||p_decision,'app_core','character_creations',p_character_id::text,
   jsonb_build_object('submitted_revision',p_submitted_revision,'decision',p_decision,'reason',p_reason));
 RETURN to_jsonb(r);
END $$;

CREATE OR REPLACE FUNCTION miniapp_features.set_character_favorite(p_user_id uuid,p_character_id uuid,p_favorited boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF p_user_id IS NULL OR p_character_id IS NULL OR p_favorited IS NULL THEN RAISE EXCEPTION 'invalid favorite' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM app_core.characters WHERE id=p_character_id FOR SHARE;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||p_character_id::text,0));
 IF p_favorited THEN
   IF NOT app_core.can_use_character(p_user_id,p_character_id) THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0002'; END IF;
   INSERT INTO miniapp_features.character_favorites(user_id,character_id) VALUES(p_user_id,p_character_id) ON CONFLICT DO NOTHING;
   IF EXISTS(SELECT 1 FROM app_core.character_creations WHERE character_id=p_character_id) THEN
     INSERT INTO app_core.character_access_grants(user_id,character_id) VALUES(p_user_id,p_character_id) ON CONFLICT DO NOTHING;
   END IF;
 ELSE
   DELETE FROM miniapp_features.character_favorites WHERE user_id=p_user_id AND character_id=p_character_id;
 END IF;
 RETURN jsonb_build_object('character_id',p_character_id,'favorited',p_favorited);
END $$;
CREATE OR REPLACE FUNCTION miniapp_features.list_character_favorites(p_user_id uuid)
RETURNS TABLE(character_id uuid,created_at timestamptz) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT f.character_id,f.created_at FROM miniapp_features.character_favorites f
 WHERE f.user_id=p_user_id AND app_core.can_use_character(p_user_id,f.character_id) ORDER BY f.created_at DESC
$$;

-- Preserve all current social throttling/idempotency/reply-like aggregation. Only replace availability.
DO $migration$
DECLARE signature text; definition text; changed text;
BEGIN
 FOREACH signature IN ARRAY ARRAY[
   'miniapp_features.get_character_socials(uuid[],uuid)',
   'miniapp_features.set_character_like(uuid,uuid,boolean)',
   'miniapp_features.create_character_comment(uuid,uuid,uuid,text)',
   'miniapp_features.report_character_comment(uuid,uuid,uuid,text)'
 ] LOOP
   definition:=pg_get_functiondef(signature::regprocedure);
   changed:=replace(definition,'c.enabled=true AND c.archived_at IS NULL','app_core.can_use_character(p_user_id,c.id)');
   IF definition=changed THEN RAISE EXCEPTION 'social function availability shape changed: %',signature; END IF;
   EXECUTE changed;
 END LOOP;
END $migration$;

-- Runtime projection is server-side and owner-bound. Trial never overwrites the approved card.
CREATE FUNCTION app_core.read_character_runtime(p_character_id uuid,p_user_id uuid,p_opening_only boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c app_core.characters; cr app_core.character_creations; result jsonb;
BEGIN
 SELECT * INTO c FROM app_core.characters WHERE id=p_character_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0404'; END IF;
 SELECT * INTO cr FROM app_core.character_creations WHERE character_id=p_character_id;
 IF FOUND THEN
   IF NOT app_core.can_use_character(p_user_id,p_character_id) THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0404'; END IF;
 END IF;
 result:=jsonb_build_object('id',c.id,'name',c.name,'description',c.description,'personality',c.personality,
   'scenario',c.scenario,'first_mes',c.first_mes,'mes_example',c.mes_example,'system_prompt',c.system_prompt,
   'post_history_instructions',c.post_history_instructions,'character_persona_and_style',to_jsonb(c)->'character_persona_and_style');
 IF cr.owner_user_id=p_user_id THEN result:=result||cr.draft_runtime; END IF;
 IF p_opening_only THEN RETURN jsonb_build_object('name',result->'name','first_mes',result->'first_mes'); END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app_core.read_character_runtime(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app_core.read_character_runtime(uuid,uuid,boolean) TO service_role;

REVOKE ALL ON FUNCTION app_core.can_discover_character(uuid),app_core.can_use_character(uuid,uuid),
 app_core.grant_creator_character_access(uuid,uuid),app_core.mutate_creator_character(uuid,uuid,text,integer,jsonb),
 app_core.review_creator_character(uuid,uuid,integer,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app_core.can_discover_character(uuid),app_core.can_use_character(uuid,uuid),
 app_core.grant_creator_character_access(uuid,uuid),app_core.mutate_creator_character(uuid,uuid,text,integer,jsonb),
 app_core.review_creator_character(uuid,uuid,integer,text,text,text) TO service_role;
REVOKE ALL ON FUNCTION miniapp_features.set_character_favorite(uuid,uuid,boolean),miniapp_features.list_character_favorites(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION miniapp_features.set_character_favorite(uuid,uuid,boolean),miniapp_features.list_character_favorites(uuid) TO service_role;
COMMIT;
NOTIFY pgrst,'reload schema';
