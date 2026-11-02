-- domain: app_core character runtime; experience first-turn version binding.
-- Production recovery: do not serialize an entire historical character row to read one text field.
-- No data/ACL changes. Atomic forward fix; reverting restores the known-broken entry path.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $fix$
DECLARE signature regprocedure; definition text; old_projection text := $$to_jsonb(c)->'character_persona_and_style'$$;
BEGIN
 FOREACH signature IN ARRAY ARRAY[
   'app_core.read_character_runtime(uuid,uuid,boolean)'::regprocedure,
   'experience.bind_creator_character_version()'::regprocedure
 ] LOOP
   definition := pg_get_functiondef(signature);
   IF strpos(definition, old_projection)=0 THEN
     IF strpos(definition, 'c.character_persona_and_style')>0 THEN CONTINUE; END IF;
     RAISE EXCEPTION 'Expected runtime projection not found in %', signature;
   END IF;
   definition := replace(definition, old_projection, 'c.character_persona_and_style');
   EXECUTE definition;
 END LOOP;
END $fix$;
COMMIT;
NOTIFY pgrst,'reload schema';
