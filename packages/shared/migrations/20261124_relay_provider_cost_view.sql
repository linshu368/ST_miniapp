-- Domain: miniapp_analytics (D); preserve existing columns, ACL and old-provider amounts.
-- Apply BEFORE 20261124_relay_provider_expand.sql. Source/plan: docs/relay-providers.md.
-- Forward fix for PG17's 0::numeric deparser spelling. The previously exercised expansion stays immutable.
DO $cost_view$
DECLARE definition text; changed text; matches integer;
BEGIN
  PERFORM set_config('lock_timeout','1s',true);
  PERFORM set_config('statement_timeout','60s',true);
  SELECT pg_get_viewdef('miniapp_analytics.llm_call_costs'::regclass,true) INTO definition;
  IF position('packy' IN definition)>0 AND position('onexmodel' IN definition)>0 THEN RETURN; END IF;
  SELECT count(*) INTO matches FROM regexp_matches(definition,'COALESCE\(l\.cost_usd, \(?0\)?::numeric\)','g');
  IF matches<>1 THEN RAISE EXCEPTION 'relay_provider: reconcile unknown cost view definition before migration'; END IF;
  changed := regexp_replace(definition,'COALESCE\(l\.cost_usd, \(?0\)?::numeric\)',
    '(CASE WHEN l.provider IN (''packy'', ''onexmodel'') THEN l.cost_usd ELSE COALESCE(l.cost_usd, 0::numeric) END)');
  -- Pending also covers known native invoices whose USD conversion is explicitly unknown.
  IF position('(l.cost_source IS NULL) AS cost_pending' IN changed)>0 THEN
    changed := replace(changed,'(l.cost_source IS NULL) AS cost_pending',
      '(l.cost_source IS NULL OR (l.provider IN (''packy'', ''onexmodel'') AND l.cost_usd IS NULL)) AS cost_pending');
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW miniapp_analytics.llm_call_costs AS ' || changed;
END
$cost_view$;
