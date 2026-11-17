-- Domain: admin configuration validation; existing app_core runtime JSON remains authoritative.
-- No tables, grants, backfill, cron or chat-path reads/writes. TEST before production.
-- Preserve the deployed validator's budget policy and ACL; fail closed on source drift.
-- Rollback: keep this compatible validator; restore application/config (custom models need pairs).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='10s';
DO $migration$
DECLARE
  definition text;
  anchor text := 'IF jsonb_typeof(p_value->''tiers'') IS DISTINCT FROM ''array'' THEN RETURN; END IF;';
  addition text := $validation$
  -- fallback-provider-pairs-v1: config writes only, no database queries.
  DECLARE
    routes jsonb := COALESCE(p_value->'fallback_provider_routes', '[]'::jsonb);
    route jsonb;
    providers jsonb;
    model_id text;
    selected_model text := COALESCE(p_value->>'fallback_model_id', 'deepseek/deepseek-v4.1-flash-1017');
    seen text[] := ARRAY[]::text[];
    matched boolean := false;
  BEGIN
    IF jsonb_typeof(routes) IS DISTINCT FROM 'array' OR jsonb_array_length(routes) > 100 THEN
      RAISE EXCEPTION 'fallback_provider_routes must be an array of at most 100 models' USING ERRCODE='22023';
    END IF;
    FOR route IN SELECT value FROM jsonb_array_elements(routes) LOOP
      model_id := route->>'model_id';
      providers := route->'preferred_providers';
      IF jsonb_typeof(route->'model_id') IS DISTINCT FROM 'string'
         OR length(model_id) > 200 OR model_id !~ '^[^[:space:]/]+/[^[:space:]/]+$'
         OR lower(model_id) = ANY(seen) THEN
        RAISE EXCEPTION 'fallback provider model IDs must be valid and unique' USING ERRCODE='22023';
      END IF;
      seen := array_append(seen, lower(model_id));
      IF jsonb_typeof(providers) IS DISTINCT FROM 'array' OR jsonb_array_length(providers) <> 2 THEN
        RAISE EXCEPTION 'fallback requires exactly two preferred providers' USING ERRCODE='22023';
      END IF;
      IF jsonb_typeof(providers->0) IS DISTINCT FROM 'string'
         OR jsonb_typeof(providers->1) IS DISTINCT FROM 'string'
         OR length(providers->>0) NOT BETWEEN 1 AND 64 OR length(providers->>1) NOT BETWEEN 1 AND 64
         OR (providers->>0) !~* '^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?$'
         OR (providers->>1) !~* '^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?$'
         OR lower(providers->>0) = lower(providers->>1) THEN
        RAISE EXCEPTION 'fallback requires two distinct valid provider slugs' USING ERRCODE='22023';
      END IF;
      matched := matched OR lower(model_id) = lower(selected_model);
    END LOOP;
    IF NOT matched AND selected_model <> 'deepseek/deepseek-v4.1-flash-1017' THEN
      RAISE EXCEPTION 'configure two preferred providers for the selected fallback model' USING ERRCODE='22023';
    END IF;
  END;
  $validation$;
BEGIN
  definition := pg_get_functiondef('admin.validate_model_catalog_first_token(jsonb)'::regprocedure);
  IF position('fallback-provider-pairs-v1' IN definition) > 0 THEN RETURN; END IF;
  IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
    RAISE EXCEPTION 'fallback validator source drift; stop migration';
  END IF;
  EXECUTE replace(definition, anchor, addition || anchor);
END;
$migration$;
COMMIT;
