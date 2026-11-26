// Pass an external PGlite module path. No application DB or account credentials are read.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const db = new PGlite();
const layout = process.argv[3] ?? 'renamed';
assert.equal(layout, 'renamed', 'Relay migrations require the current renamed schema layout');
const schema = 'analytics';
const baseline = JSON.parse(
  readFileSync(
    '.trellis/tasks/11-23-packy-onexmodel-provider-integration/research/test-function-baselines.json',
    'utf8'
  )
);
await db.exec(`
CREATE ROLE app_admin NOSUPERUSER;
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
GRANT service_role TO app_admin;
CREATE SCHEMA experience AUTHORIZATION app_admin; CREATE SCHEMA ops AUTHORIZATION app_admin;
CREATE SCHEMA admin AUTHORIZATION app_admin; CREATE SCHEMA billing AUTHORIZATION app_admin;
CREATE SCHEMA analytics AUTHORIZATION app_admin;
SET ROLE app_admin;
CREATE TABLE experience.chat_history(id uuid PRIMARY KEY,user_id uuid,model text,session_id uuid,llm_finish_reason text,llm_charge_id uuid,
 assistant_reply text,status text,created_at timestamptz DEFAULT now());
CREATE TABLE experience.chat_generation_requests(chat_history_id uuid PRIMARY KEY,delivery_attempt_id uuid,
 requested_provider text CONSTRAINT chat_generation_requests_requested_provider_check CHECK(requested_provider IN ('openrouter','venice','surplus')));
CREATE TABLE experience.chat_generation_attempts(id uuid PRIMARY KEY,chat_history_id uuid,role text,
 provider text CONSTRAINT chat_generation_attempts_provider_check CHECK(provider IN ('openrouter','venice','surplus')),
 provider_model_id text,generation_id text,dispatched_at timestamptz);
CREATE TABLE billing.usage_charges(id uuid PRIMARY KEY,quote jsonb,settled_at timestamptz,updated_at timestamptz);
CREATE TABLE ops.llm_calls(id uuid PRIMARY KEY,attempt_id uuid UNIQUE,chat_history_id uuid,
 provider text CONSTRAINT llm_calls_provider_check CHECK(provider IN ('openrouter','venice','surplus')),
 generation_id text,request_id text,provider_name text,model text,finish_reason text,call_status text,http_status integer,
 prompt_tokens bigint,completion_tokens bigint,cached_tokens bigint,reasoning_tokens bigint,cost_usd numeric,cache_cost_usd numeric,cost_source text,
 latency_ms numeric,generation_time_ms numeric,raw_usage jsonb,lane text,role text,slot smallint,candidate_id text,
 dispatched_at timestamptz,end_reason text,updated_at timestamptz DEFAULT now());
CREATE TABLE ops.llm_cost_jobs(call_id uuid PRIMARY KEY REFERENCES ops.llm_calls(id),kind text,status text,attempts integer DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
 next_retry_at timestamptz,updated_at timestamptz DEFAULT now());
ALTER TABLE ops.llm_calls ENABLE ROW LEVEL SECURITY; ALTER TABLE ops.llm_cost_jobs ENABLE ROW LEVEL SECURITY;
CREATE TABLE admin.managed_config_keys(config_key text PRIMARY KEY,managed_via text,retired_at timestamptz,note text);
CREATE FUNCTION admin.is_managed_config_key(p_key text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;

`);
const ledgerExpansion = readFileSync(
  'packages/shared/migrations/20261119_db_reorg_p6a2c3_call_ledger_expand.sql',
  'utf8'
);
// Reuse the historical projection body in today's schema; do not recreate retired namespaces.
const historicalViews = [
  ...ledgerExpansion.matchAll(
    /CREATE OR REPLACE VIEW [a-z_]+\.llm_call_costs AS\r?\n([\s\S]*?);(?=\r?\nCOMMENT ON VIEW)/g
  ),
];
assert.equal(historicalViews.length, 1, 'Expected one historical call-cost projection');
await db.exec(`CREATE VIEW analytics.llm_call_costs AS ${historicalViews[0][1]};`);
await db.exec('GRANT SELECT ON analytics.llm_call_costs TO service_role');
const declarations = {
  core: 'admin.validate_model_catalog_core(p_value jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE',
  metadata:
    'experience.record_llm_call_metadata(p_history_id uuid,p_generation_id text,p_metadata jsonb) RETURNS void LANGUAGE plpgsql',
  delivery:
    'experience.select_chat_generation_delivery(p_history_id uuid,p_attempt_id uuid,p_generation_id text) RETURNS void LANGUAGE plpgsql',
  managed:
    'admin.validate_managed_config_value(p_config_key text,p_value jsonb,p_text_value text DEFAULT NULL) RETURNS void LANGUAGE plpgsql STABLE',
  settlement: `experience.list_chat_settlement_candidates(p_scan text,p_since timestamptz,p_limit integer,p_identity_before timestamptz DEFAULT NULL)
    RETURNS TABLE(id uuid,user_id uuid,model text,session_id uuid,llm_finish_reason text,llm_charge_id uuid,assistant_reply text,status text,
    llm_billing_snapshot jsonb,llm_billing_settled_at timestamptz,delivery_provider text,generation_id text) LANGUAGE sql STABLE`,
};
const modelValidators = JSON.parse(
  readFileSync(
    '.trellis/tasks/11-23-packy-onexmodel-provider-integration/research/test-model-validator-sources.json',
    'utf8'
  )
);
for (const { signature, source } of modelValidators.functions)
  await db.exec(
    `CREATE FUNCTION ${signature.replace('(jsonb)', '(p_value jsonb)')} RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $source$${source}$source$;`
  );
for (const [name, header] of Object.entries(declarations))
  await db.exec(
    `CREATE FUNCTION ${header} SET search_path=pg_catalog AS $source$${baseline[name].source}$source$;`
  );

// PGlite has one backend: use the same index definition without CONCURRENTLY; real PG17 must verify online creation.
const sql = readFileSync('packages/shared/migrations/20261124_relay_provider_expand.sql', 'utf8');
const costViewSql = readFileSync(
  'packages/shared/migrations/20261124_relay_provider_cost_view.sql',
  'utf8'
);
// A concurrent index cannot run inside the implicit transaction of multi-statement exec.
const indexStart = sql.indexOf('CREATE UNIQUE INDEX CONCURRENTLY');
const indexEnd = sql.indexOf(';', indexStart) + 1;
const apply = async () => {
  await db.exec(sql.slice(0, indexStart));
  await db.exec(sql.slice(indexStart, indexEnd).replace('CONCURRENTLY ', ''));
  await db.exec(sql.slice(indexEnd));
};
// Missing view and unrelated function edits must stop before adding any column or config registration.
const originalView = (
  await db.query(`SELECT pg_get_viewdef('${schema}.llm_call_costs'::regclass,true) AS source`)
).rows[0].source;
await db.exec(`DROP VIEW ${schema}.llm_call_costs`);
await assert.rejects(db.exec(costViewSql), /missing prerequisite cost view/);
await assert.rejects(apply(), /missing prerequisite cost view/);
const absent = await db.query(
  "SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema='ops' AND table_name='llm_calls' AND column_name='cost_native_amount'"
);
assert.equal(absent.rows[0].count, 0);
await db.exec(
  `CREATE VIEW ${schema}.llm_call_costs AS ${originalView}; GRANT SELECT ON ${schema}.llm_call_costs TO service_role`
);
await db.exec(
  `CREATE OR REPLACE FUNCTION ${declarations.core} SET search_path=pg_catalog AS $source$${baseline.core.source}\n-- synthetic source drift\n$source$;`
);
await assert.rejects(apply(), /function source drift in admin.validate_model_catalog_core/);
await db.exec(
  `CREATE OR REPLACE FUNCTION ${declarations.core} SET search_path=pg_catalog AS $source$${baseline.core.source}$source$;`
);
await db.exec(`ALTER VIEW ${schema}.llm_call_costs SET (security_barrier=true);
  CREATE VIEW ${schema}.synthetic_cost_consumer AS SELECT id,cost_usd FROM ${schema}.llm_call_costs;`);
const viewIdentity = async () =>
  (
    await db.query(
      `SELECT oid,relowner,relacl::text,reloptions FROM pg_class WHERE oid='${schema}.llm_call_costs'::regclass`
    )
  ).rows[0];
const beforeView = await viewIdentity();
await db.exec(costViewSql);
await db.exec(costViewSql);
await apply();
await apply();
assert.deepEqual(await viewIdentity(), beforeView);
assert.equal(
  (await db.query(`SELECT count(*)::int AS count FROM ${schema}.synthetic_cost_consumer`)).rows[0]
    .count,
  0
);
const catalog = (provider) => ({
  default_model_id: 'synthetic-model',
  tiers: [
    {
      tier: 'light',
      label: 'Light',
      color: '#000000',
      cost_hint: 'fixed credits',
      sort_order: 0,
      models: [
        {
          id: 'synthetic-model',
          provider,
          provider_model_id: 'synthetic-chat',
          openrouter_model_id: 'synthetic-chat',
          display_name: 'Chat',
          tagline: 'Synthetic',
          enabled: true,
          sort_order: 0,
        },
      ],
    },
  ],
});
for (const provider of ['openrouter', 'venice', 'surplus', 'packy', 'onexmodel'])
  await db.query("SELECT admin.validate_managed_config_value('llm_model_catalog',$1::jsonb,NULL)", [
    JSON.stringify(catalog(provider)),
  ]);
await assert.rejects(
  db.query('SELECT admin.validate_model_catalog_core($1::jsonb)', [
    JSON.stringify(catalog('unrecognized-provider')),
  ])
);
await assert.rejects(
  db.query('SELECT admin.validate_model_catalog_core($1::jsonb)', [
    JSON.stringify({ ...catalog('packy'), first_token_deadline_ms: 0 }),
  ])
);
const recovery = {
  fallback_first_token_ms: 2000,
  interruption: { enabled: true, stall_ms: 2000 },
  refusal: { enabled: true, check_chars: 5, keywords: [] },
};
await db.query(
  "SELECT admin.validate_managed_config_value('chat_recovery_config',$1::jsonb,NULL)",
  [JSON.stringify(recovery)]
);
await assert.rejects(
  db.query("SELECT admin.validate_managed_config_value('chat_recovery_config',$1::jsonb,NULL)", [
    JSON.stringify({ ...recovery, fallback_first_token_ms: 0 }),
  ])
);
await db.query(
  "SELECT admin.validate_managed_config_value('llm_relay_provider_config', $1::jsonb, NULL)",
  [JSON.stringify({ packy: {}, onexmodel: {} })]
);
for (const policy of [
  { packy: {}, onexmodel: {}, key: 'forbidden' },
  { packy: { api_key: 'synthetic-forbidden-field' }, onexmodel: {} },
  { packy: { usd_per_cny: 1 }, onexmodel: {} },
  { packy: { monitor_enabled: true }, onexmodel: {} },
  { packy: { quota_per_unit: 0 }, onexmodel: {} },
])
  await assert.rejects(
    db.query('SELECT admin.validate_llm_relay_provider_config($1::jsonb)', [JSON.stringify(policy)])
  );
await assert.rejects(
  db.query(
    "SELECT admin.validate_managed_config_value('llm_relay_provider_config',$1::jsonb,'text')",
    [JSON.stringify({ packy: {}, onexmodel: {} })]
  )
);
await db.exec(`INSERT INTO ops.llm_calls(id,chat_history_id,provider,model,provider_account_ref,upstream_log_id,cost_native_amount,cost_native_unit,cost_source)
VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000010','packy','synthetic-model','synthetic-account','synthetic-invoice',0,'quota','relay_invoice');`);
await db.exec("UPDATE ops.llm_calls SET dispatched_at=now() WHERE provider='packy'");
const unknown = await db.query(`SELECT cost_usd,cost_pending FROM ${schema}.llm_call_costs`);
assert.equal(unknown.rows[0].cost_usd, null);
assert.equal(unknown.rows[0].cost_pending, true);
await assert.rejects(
  db.exec(
    `INSERT INTO ops.llm_calls(id,provider,provider_account_ref,upstream_log_id) VALUES('00000000-0000-4000-8000-000000000002','packy','synthetic-account','synthetic-invoice')`
  )
);
await db.exec(
  `INSERT INTO ops.llm_calls(id,provider,provider_account_ref,upstream_log_id) VALUES('00000000-0000-4000-8000-000000000003','onexmodel','synthetic-account','synthetic-invoice')`
);
await assert.rejects(
  db.exec(`UPDATE ops.llm_calls SET cost_native_amount=-1 WHERE provider='packy'`)
);
await assert.rejects(
  db.exec(`UPDATE ops.llm_calls SET cost_usd_per_native_unit=0 WHERE provider='packy'`)
);
await assert.rejects(
  db.exec(
    `UPDATE ops.llm_calls SET raw_usage=jsonb_build_object('oversized',repeat('x',33000)) WHERE provider='packy'`
  )
);
await db.exec('SET ROLE anon');
await assert.rejects(db.query('SELECT * FROM ops.llm_calls'));
await assert.rejects(db.query("SELECT admin.validate_llm_relay_provider_config('{}')"));
await db.exec('SET ROLE app_admin');
const version = (await db.query('SELECT version()')).rows[0].version;
console.log(
  JSON.stringify({
    ok: true,
    engine: version,
    owner: 'app_admin NOSUPERUSER',
    layout,
    checks: [
      'expansion',
      'replay',
      'provider checks',
      'policy failure paths',
      'invoice uniqueness',
      'unknown USD',
      'zero quota',
      'native amount/rate bounds',
      'snapshot limit',
      'anonymous denial',
      'source drift refused before expansion',
      'view identity/options/ACL/dependents preserved',
      'canonical analytics prerequisite without retired schema recreation',
      'both relay catalog publications accepted with current TEST validators',
      'existing first-token and recovery config guards preserved',
    ],
    limitation:
      'WASM single backend; not remote TEST/production or multi-session concurrency/capacity evidence',
  })
);
await db.close();
