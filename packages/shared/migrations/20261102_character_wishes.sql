-- Domain: miniapp_features. Wishes/support/responses are feature-owned runtime state.
-- Dependencies: app_core users/characters/character_creations/can_discover_character,
-- miniapp_features notifications with VIP kind/business_key/metadata constraints.
-- Only the authenticated backend invokes these service_role RPCs. All wishes are anonymous
-- and public; both public/mine DTOs omit author identity. Only the owner can withdraw a wish.
-- Response + recipient notifications commit together; business_key and response PK deduplicate.
-- Deploy migration before backend/frontend. Rollback: disable routes/entries and retain tables;
-- revert notification constraints only after removing character_wish_response rows.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE miniapp_features.character_wishes (
 id uuid PRIMARY KEY,
 owner_user_id uuid NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
 body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 500),
 visibility text NOT NULL CHECK (visibility='public'),
 created_at timestamptz NOT NULL DEFAULT now(),
 withdrawn_at timestamptz
);
CREATE INDEX character_wishes_public_created_idx ON miniapp_features.character_wishes(created_at DESC,id DESC)
 WHERE visibility='public' AND withdrawn_at IS NULL;
CREATE INDEX character_wishes_owner_created_idx ON miniapp_features.character_wishes(owner_user_id,created_at DESC,id DESC)
 WHERE withdrawn_at IS NULL;
CREATE TABLE miniapp_features.character_wish_supports (
 wish_id uuid NOT NULL REFERENCES miniapp_features.character_wishes(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(wish_id,user_id)
);
CREATE INDEX character_wish_supports_user_idx ON miniapp_features.character_wish_supports(user_id);
CREATE TABLE miniapp_features.character_wish_responses (
 wish_id uuid NOT NULL REFERENCES miniapp_features.character_wishes(id) ON DELETE CASCADE,
 character_id uuid NOT NULL REFERENCES app_core.characters(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(wish_id,character_id)
);
CREATE INDEX character_wish_responses_character_idx ON miniapp_features.character_wish_responses(character_id);
ALTER TABLE miniapp_features.character_wishes ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp_features.character_wish_supports ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp_features.character_wish_responses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp_features.character_wishes,miniapp_features.character_wish_supports,
 miniapp_features.character_wish_responses FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON miniapp_features.character_wishes,miniapp_features.character_wish_supports,
 miniapp_features.character_wish_responses TO service_role;
COMMENT ON TABLE miniapp_features.character_wishes IS 'Anonymous public wishes only; private visibility is rejected; only the author can withdraw';
COMMENT ON TABLE miniapp_features.character_wish_supports IS 'Unique additional viewers who want the wish; the author contributes the initial one without a support row';
COMMENT ON TABLE miniapp_features.character_wish_responses IS 'Published public creator cards responding to a wish; no exclusive claim';

ALTER TABLE miniapp_features.notifications
 DROP CONSTRAINT notifications_kind_check,
 DROP CONSTRAINT notifications_vip_expiry_shape_check,
 ADD CONSTRAINT notifications_kind_check CHECK (kind IS NULL OR kind IN ('vip_expiry','character_wish_response')),
 ADD CONSTRAINT notifications_vip_expiry_shape_check CHECK (
   (kind IS NULL AND business_key IS NULL AND metadata IS NULL)
   OR (kind='vip_expiry' AND business_key IS NOT NULL AND user_id IS NOT NULL AND scope='official'
     AND metadata IS NOT NULL AND jsonb_typeof(metadata)='object'
     AND (metadata-'reminder_window'-'observed_valid_until')='{}'::jsonb
     AND metadata->>'reminder_window' IN ('expiring_soon','expires_today')
     AND char_length(trim(metadata->>'observed_valid_until'))>0)
   OR (kind='character_wish_response' AND business_key IS NOT NULL AND user_id IS NOT NULL
     AND scope='personal' AND category='interaction' AND metadata IS NOT NULL
     AND jsonb_typeof(metadata)='object' AND metadata ?& ARRAY['wish_id','character_id']
     AND (metadata-'wish_id'-'character_id')='{}'::jsonb
     AND coalesce(metadata->>'wish_id','') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND coalesce(metadata->>'character_id','') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND action_path IS NOT NULL AND action_path='/wishes/'||(metadata->>'wish_id'))
 );
COMMENT ON COLUMN miniapp_features.notifications.kind IS 'vip_expiry or character_wish_response; legacy notifications use NULL';

-- Internal projection, not granted to API roles: ownership is checked by the callers below.
CREATE FUNCTION miniapp_features.character_wish_dto(p_wish miniapp_features.character_wishes,p_user_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',p_wish.id,'body',p_wish.body,'visibility',p_wish.visibility,
   'created_at',p_wish.created_at,'is_mine',p_wish.owner_user_id=p_user_id,
   'supported',EXISTS(SELECT 1 FROM miniapp_features.character_wish_supports s WHERE s.wish_id=p_wish.id AND s.user_id=p_user_id),
   'wanted_count',1+(SELECT count(*) FROM miniapp_features.character_wish_supports s WHERE s.wish_id=p_wish.id),
   'response_count',(SELECT count(*) FROM miniapp_features.character_wish_responses r
     WHERE r.wish_id=p_wish.id AND app_core.can_discover_character(r.character_id)))
$$;

CREATE FUNCTION miniapp_features.list_character_wishes(p_user_id uuid,p_scope text,p_sort text,p_page integer,p_page_size integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;
BEGIN
 IF p_user_id IS NULL OR p_scope NOT IN ('public','mine') OR p_sort NOT IN ('newest','popular')
   OR p_page NOT BETWEEN 1 AND 10000 OR p_page_size NOT BETWEEN 1 AND 20 THEN
   RAISE EXCEPTION 'invalid wish query' USING ERRCODE='22023';
 END IF;
 WITH visible AS MATERIALIZED (
   SELECT w.* FROM miniapp_features.character_wishes w WHERE w.withdrawn_at IS NULL
   AND ((p_scope='public' AND w.visibility='public') OR (p_scope='mine' AND w.owner_user_id=p_user_id))
 ), ranked AS (
   SELECT v.*,CASE WHEN p_sort='popular' THEN (SELECT count(*) FROM miniapp_features.character_wish_supports s WHERE s.wish_id=v.id) ELSE 0 END popularity
   FROM visible v
 ), page_rows AS (
   SELECT * FROM ranked ORDER BY popularity DESC,created_at DESC,id DESC LIMIT p_page_size OFFSET (p_page-1)*p_page_size
 ) SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(miniapp_features.character_wish_dto(w,p_user_id)
     ORDER BY p.popularity DESC,p.created_at DESC,p.id DESC)
     FROM page_rows p JOIN miniapp_features.character_wishes w ON w.id=p.id),'[]'::jsonb),
   'total',(SELECT count(*) FROM visible),'page',p_page,'page_size',p_page_size) INTO result;
 RETURN result;
END $$;

CREATE FUNCTION miniapp_features.read_character_wish(p_user_id uuid,p_wish_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w miniapp_features.character_wishes; cards jsonb;
BEGIN
 SELECT * INTO w FROM miniapp_features.character_wishes WHERE id=p_wish_id AND withdrawn_at IS NULL
   AND p_user_id IS NOT NULL AND visibility='public';
 IF NOT FOUND THEN RAISE EXCEPTION 'wish unavailable' USING ERRCODE='P0404'; END IF;
 SELECT coalesce(jsonb_agg(row_to_json(c)), '[]'::jsonb) INTO cards FROM (
   SELECT c.id,c.name,c.description,NULLIF(c.avatar_url,'') AS cover_url FROM miniapp_features.character_wish_responses r
   JOIN app_core.characters c ON c.id=r.character_id WHERE r.wish_id=w.id AND app_core.can_discover_character(c.id)
   ORDER BY r.created_at DESC,r.character_id DESC LIMIT 20
 ) c;
 RETURN jsonb_build_object('wish',miniapp_features.character_wish_dto(w,p_user_id),'cards',cards);
END $$;

CREATE FUNCTION miniapp_features.mutate_character_wish(p_user_id uuid,p_wish_id uuid,p_action text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE w miniapp_features.character_wishes; card_id uuid; card_name text; inserted integer;
BEGIN
 IF p_user_id IS NULL OR p_wish_id IS NULL OR p_action NOT IN ('create','support','withdraw','respond')
   OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' THEN
   RAISE EXCEPTION 'invalid wish operation' USING ERRCODE='22023';
 END IF;
 -- Same character-first lock order as creator mutations. Published runtime is authoritative,
 -- never expose the newer draft name/cover while its owner is still editing it.
 IF p_action='respond' THEN
   card_id:=(p_payload->>'character_id')::uuid;
   SELECT c.name INTO card_name FROM app_core.characters c WHERE c.id=card_id FOR SHARE;
   IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM app_core.character_creations cr
     WHERE cr.character_id=card_id AND cr.owner_user_id=p_user_id AND cr.state='ready' AND cr.visibility='public'
       AND cr.approved_revision IS NOT NULL) OR NOT app_core.can_discover_character(card_id) THEN
     RAISE EXCEPTION 'public owned character required' USING ERRCODE='P0404';
   END IF;
 END IF;
 IF p_action='create' THEN
   IF p_payload->>'visibility' IS DISTINCT FROM 'public' OR NOT (p_payload ?& ARRAY['body','visibility'])
     OR char_length(btrim(p_payload->>'body')) NOT BETWEEN 1 AND 500 THEN
     RAISE EXCEPTION 'invalid wish' USING ERRCODE='22023';
   END IF;
   INSERT INTO miniapp_features.character_wishes(id,owner_user_id,body,visibility)
     VALUES(p_wish_id,p_user_id,btrim(p_payload->>'body'),p_payload->>'visibility') ON CONFLICT DO NOTHING;
 END IF;
 SELECT * INTO w FROM miniapp_features.character_wishes WHERE id=p_wish_id FOR UPDATE;
 IF NOT FOUND
   OR (w.withdrawn_at IS NOT NULL AND NOT (p_action='withdraw' AND w.owner_user_id=p_user_id)) THEN
   RAISE EXCEPTION 'wish unavailable' USING ERRCODE='P0404';
 END IF;
 IF p_action='create' THEN
   IF w.owner_user_id<>p_user_id THEN RAISE EXCEPTION 'wish unavailable' USING ERRCODE='P0404'; END IF;
   IF w.body IS DISTINCT FROM btrim(p_payload->>'body') OR w.visibility IS DISTINCT FROM p_payload->>'visibility' THEN
     RAISE EXCEPTION 'wish already exists' USING ERRCODE='P0409';
   END IF;
 ELSIF p_action='support' THEN
   IF w.visibility<>'public' THEN RAISE EXCEPTION 'wish unavailable' USING ERRCODE='P0404'; END IF;
   IF jsonb_typeof(p_payload->'supported') IS DISTINCT FROM 'boolean' OR w.owner_user_id=p_user_id THEN
     RAISE EXCEPTION 'invalid support' USING ERRCODE='22023';
   END IF;
   IF (p_payload->>'supported')::boolean THEN
     INSERT INTO miniapp_features.character_wish_supports(wish_id,user_id) VALUES(p_wish_id,p_user_id) ON CONFLICT DO NOTHING;
   ELSE DELETE FROM miniapp_features.character_wish_supports WHERE wish_id=p_wish_id AND user_id=p_user_id;
   END IF;
 ELSIF p_action='withdraw' THEN
   IF w.owner_user_id<>p_user_id THEN RAISE EXCEPTION 'wish unavailable' USING ERRCODE='P0404'; END IF;
   UPDATE miniapp_features.character_wishes SET withdrawn_at=coalesce(withdrawn_at,now()) WHERE id=p_wish_id;
   RETURN jsonb_build_object('withdrawn',true);
 ELSIF p_action='respond' THEN
   IF w.visibility<>'public' THEN RAISE EXCEPTION 'wish unavailable' USING ERRCODE='P0404'; END IF;
   INSERT INTO miniapp_features.character_wish_responses(wish_id,character_id) VALUES(p_wish_id,card_id) ON CONFLICT DO NOTHING;
   GET DIAGNOSTICS inserted=ROW_COUNT;
   IF inserted=1 THEN
     INSERT INTO miniapp_features.notifications(scope,category,title,body,user_id,is_published,published_at,kind,business_key,action_path,metadata)
     SELECT 'personal','interaction','你期待的角色有回应了','「'||left(card_name,100)||'」已经可以体验，去看看吧。',recipient,
       true,now(),'character_wish_response','wish_response:'||p_wish_id::text||':'||card_id::text||':'||recipient::text,
       '/wishes/'||p_wish_id::text,jsonb_build_object('wish_id',p_wish_id,'character_id',card_id)
     FROM (SELECT w.owner_user_id AS recipient UNION SELECT user_id FROM miniapp_features.character_wish_supports WHERE wish_id=p_wish_id) recipients
     WHERE recipient<>p_user_id
     ON CONFLICT (business_key) WHERE business_key IS NOT NULL DO NOTHING;
   END IF;
   RETURN jsonb_build_object('linked',true);
 END IF;
 RETURN jsonb_build_object('wish',miniapp_features.character_wish_dto(w,p_user_id));
END $$;

REVOKE ALL ON FUNCTION miniapp_features.character_wish_dto(miniapp_features.character_wishes,uuid),
 miniapp_features.list_character_wishes(uuid,text,text,integer,integer),
 miniapp_features.read_character_wish(uuid,uuid),miniapp_features.mutate_character_wish(uuid,uuid,text,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION miniapp_features.list_character_wishes(uuid,text,text,integer,integer),
 miniapp_features.read_character_wish(uuid,uuid),miniapp_features.mutate_character_wish(uuid,uuid,text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
