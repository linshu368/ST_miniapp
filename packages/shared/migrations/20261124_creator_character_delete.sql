-- Domain: app_core（作者草稿与发布状态）
-- 设计：.trellis/tasks/11-24-creator-card-delete/design.md；落位规则见 docs/db/CONTRACT.md §2。
--
-- 创作者删除自己的角色卡 = 强制私密 + 打上已删除标记：
--   1. app_core.character_creations.deleted_at（S，与表同性质、同写入模块 backend/features/creator）：
--      作者删除的时间；NULL = 未删除。后端据此从作者列表/编辑读取里过滤，删除不可恢复。
--   2. app_core.mutate_creator_character 新增 'delete' 动作：
--      - 同一把锁下把卡转私密（与现在的转私密分支同样清掉审核/提交字段），写 deleted_at；重复删除原样返回。
--      - 已删除的卡再 create/save/publish/visibility 一律 P0404。
--      卡内容（app_core.characters）与 published_revision 不动：已收藏或聊过的玩家凭 character_access_grants
--      继续用删除前发布的那一版；公开入口（can_discover_character 及同口径查询）因为私密自然看不到。
--
-- 函数整体替换。前置校验：现行源码的 md5 必须等于 2026-11-24 生产实测值，或已含 deleted_at（重跑）；
-- 对不上就拒绝执行，避免覆盖未知改动。
-- 不改旧数据（现有行 deleted_at 全为 NULL）。
-- 执行顺序：TEST → 生产；先迁移，再部署后端与前端（新后端读 deleted_at）。
-- 回滚：回退后端/前端即可，列和函数保留（已删除的卡在旧后端上作为私密卡重新出现在作者列表）。
--   如需彻底撤销：把下面的函数去掉四处后重新 CREATE OR REPLACE（得到的就是前置校验 md5 对应的旧定义）——
--   允许值里的 'delete'、create 分支的 `OR r.deleted_at IS NOT NULL`、`IF p_action='delete' ... END IF;` 整段、
--   紧随其后的 `IF r.deleted_at IS NOT NULL THEN ... END IF;` 一行；再
--   ALTER TABLE app_core.character_creations DROP COLUMN deleted_at;
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
DECLARE
  v_src text;
BEGIN
  IF to_regclass('app_core.character_creations') IS NULL
     OR to_regclass('app_core.character_listings') IS NULL
     OR to_regprocedure('app_core.mutate_creator_character(uuid,uuid,text,integer,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'creator delete: prerequisite objects missing';
  END IF;
  SELECT replace(prosrc, E'\r', '') INTO v_src FROM pg_proc
  WHERE oid = 'app_core.mutate_creator_character(uuid,uuid,text,integer,jsonb)'::regprocedure;
  IF position('deleted_at' IN v_src) = 0 AND md5(v_src) <> '160f07aba2b38e80ba8fa85032f3dd5e' THEN
    RAISE EXCEPTION 'creator delete: mutate_creator_character differs from the expected definition (md5 %); refusing to replace', md5(v_src);
  END IF;
END
$preflight$;

ALTER TABLE app_core.character_creations ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL;
COMMENT ON COLUMN app_core.character_creations.deleted_at IS
  '作者删除的时间；NULL = 未删除。删除时同一事务转为私密，已收藏或聊过的玩家继续可用；后端从作者列表与编辑读取中过滤。不可恢复。';

CREATE OR REPLACE FUNCTION app_core.mutate_creator_character(p_user_id uuid, p_character_id uuid, p_action text, p_expected_revision integer, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE r app_core.character_creations; next_revision integer; cover uuid; mutation jsonb;
BEGIN
 IF p_user_id IS NULL OR p_character_id IS NULL OR p_action NOT IN ('create','save','publish','visibility','delete') OR p_payload IS NULL THEN
   RAISE EXCEPTION 'invalid creator mutation' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('creator:'||p_character_id::text,0));
 IF p_action='create' THEN
   SELECT * INTO r FROM app_core.character_creations WHERE character_id=p_character_id;
   IF FOUND THEN
     IF r.owner_user_id<>p_user_id OR r.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0404'; END IF;
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
   INSERT INTO app_core.characters(id,name) VALUES(p_character_id,'');
   UPDATE app_core.character_listings SET enabled=true,sort_order=2147483647,updated_at=now() WHERE character_id=p_character_id;
   INSERT INTO app_core.character_creations(character_id,owner_user_id,draft,draft_runtime,cover_asset_id)
   VALUES(p_character_id,p_user_id,p_payload->'draft',p_payload->'runtime',cover) RETURNING * INTO r;
   RETURN to_jsonb(r);
 END IF;
 PERFORM 1 FROM app_core.characters WHERE id=p_character_id FOR UPDATE;
 SELECT * INTO r FROM app_core.character_creations WHERE character_id=p_character_id FOR UPDATE;
 IF NOT FOUND OR r.owner_user_id<>p_user_id THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0404'; END IF;
 IF p_action='delete' THEN
   -- Soft delete: hidden from its owner and every public entry, while grant holders keep the
   -- published version. No revision check: deleting does not depend on the draft content.
   IF r.deleted_at IS NULL THEN
     UPDATE app_core.character_creations SET visibility='private',review_status='not_submitted',review_message=NULL,
       submitted_revision=NULL,approved_revision=NULL,submission=NULL,revision=r.revision+1,last_mutation=NULL,
       deleted_at=now(),updated_at=now()
     WHERE character_id=p_character_id RETURNING * INTO r;
   END IF;
   RETURN to_jsonb(r);
 END IF;
 IF r.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0404'; END IF;
 -- Idempotency is the client intent. A server preset asset update must not change a replay.
 mutation:=jsonb_build_object('action',p_action,'expected_revision',p_expected_revision,'payload',p_payload-'runtime'-'review');
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
       first_mes=r.draft_runtime->>'first_mes',system_prompt=r.draft_runtime->>'system_prompt',status_bar_detail=r.draft_runtime->'status_bar',tags=r.draft->'tags',
       avatar_url=CASE WHEN r.cover_asset_id IS NULL THEN '' ELSE 'creator-cover:'||r.cover_asset_id::text END,
       updated_at=now() WHERE id=p_character_id;
     UPDATE app_core.character_listings SET last_listed_at=now(),updated_at=now()
       WHERE character_id=p_character_id AND r.visibility='public' AND r.review_status='approved'
         AND (SELECT approved_revision IS NULL FROM app_core.character_creations WHERE character_id=p_character_id);
     r.state:='ready'; r.published_revision:=next_revision;
     IF r.visibility='private' OR r.review_status<>'approved' THEN r.approved_revision:=NULL; END IF;
   END IF;
 END IF;
 UPDATE app_core.character_creations SET draft=r.draft,draft_runtime=r.draft_runtime,cover_asset_id=r.cover_asset_id,
 state=r.state,visibility=r.visibility,review_status=r.review_status,review_message=r.review_message,
 revision=next_revision,submitted_revision=r.submitted_revision,published_revision=r.published_revision,
 approved_revision=r.approved_revision,submission=r.submission,last_mutation=mutation,updated_at=now()
 WHERE character_id=p_character_id RETURNING * INTO r;
 RETURN to_jsonb(r);
END $function$;

DO $verify$
BEGIN
  IF position('deleted_at' IN (SELECT prosrc FROM pg_proc
       WHERE oid = 'app_core.mutate_creator_character(uuid,uuid,text,integer,jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'creator delete: function not replaced';
  END IF;
  IF has_function_privilege('anon', 'app_core.mutate_creator_character(uuid,uuid,text,integer,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_core.mutate_creator_character(uuid,uuid,text,integer,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'creator delete: function privileges widened unexpectedly';
  END IF;
END
$verify$;

COMMIT;
