-- domain: app_core immutable character versions; experience sessions only reference one version.
-- After creator_cover_assets and creator_characters. No production execution is implied.
-- First actual chat_history INSERT binds within the existing start-turn transaction; opening an
-- empty session does not freeze anything. Official cards retain their established behavior.
-- Rollback: revert application readers first; retain immutable versions/session references.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
CREATE TABLE app_core.character_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES app_core.characters(id) ON DELETE RESTRICT,
  audience text NOT NULL CHECK(audience IN ('owner','published')),
  source_revision integer NOT NULL CHECK(source_revision>0),
  runtime jsonb NOT NULL,
  presentation jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(character_id,audience,source_revision),
  UNIQUE(id,character_id)
);
ALTER TABLE app_core.character_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_core.character_versions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON app_core.character_versions TO service_role;
ALTER TABLE experience.chat_sessions ADD COLUMN character_version_id uuid;
ALTER TABLE experience.chat_sessions ADD CONSTRAINT chat_sessions_character_version_fkey
 FOREIGN KEY(character_version_id,character_id) REFERENCES app_core.character_versions(id,character_id) ON DELETE RESTRICT;
CREATE INDEX chat_sessions_character_version_idx ON experience.chat_sessions(character_version_id) WHERE character_version_id IS NOT NULL;
COMMENT ON COLUMN experience.chat_sessions.character_version_id IS 'Bound on first real user turn; branches inherit it. No session-specific editing or update toggle.';
CREATE FUNCTION app_core.guard_character_version_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'character versions are immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER character_versions_immutable BEFORE UPDATE OR DELETE ON app_core.character_versions
FOR EACH ROW EXECUTE FUNCTION app_core.guard_character_version_immutable();
ALTER TABLE app_core.character_versions ENABLE ALWAYS TRIGGER character_versions_immutable;

CREATE FUNCTION experience.bind_creator_character_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s experience.chat_sessions; c app_core.characters; cr app_core.character_creations;
 version_id uuid; v_source_revision integer; v_audience text; runtime jsonb; presentation jsonb;
BEGIN
 IF NEW.session_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO s FROM experience.chat_sessions WHERE id=NEW.session_id FOR UPDATE;
 IF NOT FOUND OR s.character_version_id IS NOT NULL THEN RETURN NEW; END IF;
 -- Core mutations lock character then creation. Holding the character share lock across both
 -- reads makes prompt and cover/title a consistent version, even during concurrent approval.
 SELECT * INTO c FROM app_core.characters WHERE id=s.character_id FOR SHARE;
 SELECT * INTO cr FROM app_core.character_creations WHERE character_id=s.character_id FOR SHARE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF NOT app_core.can_use_character(s.user_id,s.character_id) THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0404'; END IF;
 runtime:=jsonb_build_object('id',c.id,'name',c.name,'description',c.description,'personality',c.personality,
   'scenario',c.scenario,'first_mes',c.first_mes,'mes_example',c.mes_example,'system_prompt',c.system_prompt,
   'post_history_instructions',c.post_history_instructions,'character_persona_and_style',to_jsonb(c)->'character_persona_and_style');
 presentation:=jsonb_build_object('name',c.name,'description',c.description,'avatar_url',c.avatar_url,'tags',c.tags,
   'creator',c.creator,'first_mes',c.first_mes,'creator_notes',c.creator_notes);
 IF cr.owner_user_id=s.user_id THEN
   v_audience:='owner'; v_source_revision:=cr.revision; runtime:=runtime||cr.draft_runtime;
   presentation:=presentation||jsonb_build_object('name',cr.draft->>'name','description',cr.draft->>'description',
     'tags',cr.draft->'tags','first_mes',cr.draft->>'opening',
     'avatar_url',CASE WHEN cr.cover_asset_id IS NULL THEN '' ELSE 'creator-cover:'||cr.cover_asset_id::text END);
 ELSE
   v_audience:='published'; v_source_revision:=cr.published_revision;
 END IF;
 IF v_source_revision IS NULL THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0404'; END IF;
 INSERT INTO app_core.character_versions(character_id,audience,source_revision,runtime,presentation)
 VALUES(s.character_id,v_audience,v_source_revision,runtime,presentation) ON CONFLICT DO NOTHING RETURNING id INTO version_id;
 IF version_id IS NULL THEN
   SELECT v.id INTO version_id FROM app_core.character_versions v WHERE v.character_id=s.character_id AND v.audience=v_audience AND v.source_revision=v_source_revision;
 END IF;
 UPDATE experience.chat_sessions SET character_version_id=version_id WHERE id=s.id;
 RETURN NEW;
END $$;
CREATE TRIGGER bind_creator_character_version BEFORE INSERT ON experience.chat_history
FOR EACH ROW EXECUTE FUNCTION experience.bind_creator_character_version();

CREATE FUNCTION experience.inherit_creator_character_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.branch_source_session_id IS NOT NULL THEN
   SELECT s.character_version_id INTO NEW.character_version_id FROM experience.chat_sessions s
   WHERE s.id=NEW.branch_source_session_id AND s.user_id=NEW.user_id AND s.character_id=NEW.character_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'branch source unavailable' USING ERRCODE='P0404'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inherit_creator_character_version BEFORE INSERT ON experience.chat_sessions
FOR EACH ROW EXECUTE FUNCTION experience.inherit_creator_character_version();

CREATE FUNCTION app_core.read_session_character_version(p_character_id uuid,p_user_id uuid,p_session_id uuid,p_presentation boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s experience.chat_sessions; v app_core.character_versions;
BEGIN
 SELECT * INTO s FROM experience.chat_sessions WHERE id=p_session_id AND user_id=p_user_id AND character_id=p_character_id AND deleted_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'session unavailable' USING ERRCODE='P0404'; END IF;
 IF s.character_version_id IS NULL THEN RETURN NULL; END IF;
 IF NOT app_core.can_use_character(p_user_id,p_character_id) THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0404'; END IF;
 SELECT * INTO v FROM app_core.character_versions WHERE id=s.character_version_id AND character_id=p_character_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'character version unavailable' USING ERRCODE='P0404'; END IF;
 RETURN CASE WHEN p_presentation THEN v.presentation ELSE v.runtime END;
END $$;
CREATE FUNCTION app_core.read_session_character_runtime(p_character_id uuid,p_user_id uuid,p_session_id uuid,p_opening_only boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;
BEGIN
 result:=app_core.read_session_character_version(p_character_id,p_user_id,p_session_id,false);
 IF result IS NULL THEN RETURN app_core.read_character_runtime(p_character_id,p_user_id,p_opening_only); END IF;
 IF p_opening_only THEN RETURN jsonb_build_object('name',result->'name','first_mes',result->'first_mes'); END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app_core.guard_character_version_immutable(),experience.bind_creator_character_version(),experience.inherit_creator_character_version(),
 app_core.read_session_character_version(uuid,uuid,uuid,boolean),app_core.read_session_character_runtime(uuid,uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app_core.read_session_character_version(uuid,uuid,uuid,boolean),app_core.read_session_character_runtime(uuid,uuid,uuid,boolean) TO service_role;
COMMIT;
NOTIFY pgrst,'reload schema';
