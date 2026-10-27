# Implementation and release

1. Preserve live dashboard/cron definitions as local recovery evidence, no credentials/user rows.
2. Reuse experience created_at index, charge_key and provider-history unique indexes; payment paid_at index. No new source index, trigger, streaming/billing behavior or general aggregation platform.
3. Create one14-day/date+scope+model aggregate cache in miniapp_analytics and one owner-only daily refresher. Bounded caller5s/lock1s/single worker; transaction advisory lock avoids competing refreshes; atomic delete/reinsert preserves prior snapshots on error. Missing days/freshness/cost coverage remain visible.
4. Retire eleven old full-history cron entries, retain their materialized data and schema. One30minute job updates only today+yesterday; initially off pending local/TEST/production smoke.
5. Consolidate operating panels into st-model-overview; replace other4dashboards with retirement notices and links, no hidden SQL/variable queries. First-token dashboard stays independent. Expose cache-only7-day metrics, sample/coverage and last refresh.
6. Real localPG fixture tests and reader ACL; TEST workflow, production workflow, per-day sequential bounded bootstrap, enable one cron only after success. Stop on5s failure; don't extend timeout. Publish Grafana and verify every panel query; CI/admin merge under user's direct-release authorization.
7. Recovery: disable new cron; restore exported dashboard/cron settings only after resource review. No source data deletion or historic backfill; don't reactivate removed heavy refreshes blindly.
