-- Domain: analytics (D); preserve columns, OID, ACL, options and existing provider costs.
-- Run before 20261124_relay_provider_expand.sql. User explicitly requested corrections to both files after TEST failure.
-- Requires the canonical analytics schema after the p7 rename and contract migrations.
DO $cost_view$
DECLARE target regclass; definition text; changed text; matches integer; options text;
BEGIN
  PERFORM set_config('lock_timeout','1s',true);
  PERFORM set_config('statement_timeout','60s',true);
  target := to_regclass('analytics.llm_call_costs');
  IF target IS NULL THEN
    RAISE EXCEPTION 'relay_provider: missing prerequisite cost view in analytics; inspect migration ledger';
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid=target)<>'v' THEN
    RAISE EXCEPTION 'relay_provider: cost projection is not an ordinary view';
  END IF;
  definition := pg_get_viewdef(target,true);
  changed := definition;
  IF NOT (position('packy' IN definition)>0 AND position('onexmodel' IN definition)>0) THEN
    SELECT count(*) INTO matches FROM regexp_matches(definition,'COALESCE\(l\.cost_usd, \(?0\)?::numeric\)','g');
    IF matches<>1 THEN RAISE EXCEPTION 'relay_provider: reconcile unknown cost view definition before migration'; END IF;
    changed := regexp_replace(definition,'COALESCE\(l\.cost_usd, \(?0\)?::numeric\)',
      '(CASE WHEN l.provider IN (''packy'', ''onexmodel'') THEN l.cost_usd ELSE COALESCE(l.cost_usd, 0::numeric) END)');
  END IF;
  -- PG17 emits both parenthesized and bare booleans. Native invoices with unknown USD remain pending.
  IF position('l.cost_usd IS NULL' IN regexp_replace(changed,'[()]','','g'))=0 THEN
    SELECT count(*) INTO matches FROM regexp_matches(changed,'\(?l\.cost_source IS NULL\)? AS cost_pending','g');
    IF matches<>1 THEN RAISE EXCEPTION 'relay_provider: reconcile unknown cost_pending definition'; END IF;
    changed := regexp_replace(changed,'\(?l\.cost_source IS NULL\)? AS cost_pending',
      '(l.cost_source IS NULL OR (l.provider IN (''packy'', ''onexmodel'') AND l.cost_usd IS NULL)) AS cost_pending');
  END IF;
  IF changed<>definition THEN
    SELECT string_agg(format('%I=%L',option_name,option_value),', ') INTO options
      FROM pg_options_to_table((SELECT reloptions FROM pg_class WHERE oid=target));
    EXECUTE format('CREATE OR REPLACE VIEW %s%s AS %s',target,
      CASE WHEN options IS NULL THEN '' ELSE format(' WITH (%s)',options) END,changed);
  END IF;
END
$cost_view$;
