// Disposable WASM PostgreSQL only; no URLs, environment credentials or network.
// node <this-file> <path-to-installed-pglite/dist/index.js> [repository-root]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.ok(process.argv[2], 'Pass the local PGlite module path');
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const root = resolve(process.argv[3] ?? process.cwd());
const db = new PGlite();
const read = (path) => readFile(resolve(root, path), 'utf8');
const migrationPath = 'packages/shared/migrations/';
const originalPath = `${migrationPath}20261110_surplusintelligence_chat_history.sql`;
const compatPath = `${migrationPath}20261110_surplusintelligence_chat_history_compat.sql`;
const original = await read(originalPath);
const originalHash = createHash('sha256').update(original).digest('hex');
const lf = (value) => value.replace(/\r\n/g, '\n');
const crlf = (value) => lf(value).replace(/\n/g, '\r\n');
// Keep each scenario atomic without nesting the migration's top-level transaction.
const body = (value) => value.replace(/^(?:BEGIN|COMMIT);\s*$/gm, '');
const functionQuery = `SELECT oid, proowner, proacl, pg_get_functiondef(oid) AS definition
  FROM pg_proc WHERE oid IN ('admin.validate_model_catalog_core(jsonb)'::regprocedure,
    'experience.select_chat_generation_delivery(uuid,uuid,text)'::regprocedure) ORDER BY oid`;
const identities = (rows) => rows.map(({ definition, ...identity }) => identity);
const snapshot = async () => ({
  functions: (await db.query(functionQuery)).rows,
  table: (
    await db.query("SELECT to_regclass('experience.surplusintelligence_chat_history') AS relation")
  ).rows,
  checks: (
    await db.query(`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid IN ('experience.chat_generation_attempts'::regclass,
      'experience.chat_generation_requests'::regclass) ORDER BY conname`)
  ).rows,
});
const deliveryDefinition = async () =>
  (
    await db.query(`SELECT pg_get_functiondef(
  'experience.select_chat_generation_delivery(uuid,uuid,text)'::regprocedure) AS definition`)
  ).rows[0].definition;
const untouched = (definition) => {
  const normalized = lf(definition);
  const start = normalized.indexOf("  IF a.provider='openrouter' THEN");
  const end = normalized.indexOf('  -- The entire quote stays intact;');
  assert.ok(start >= 0 && end > start, 'Known provider boundaries missing');
  return [normalized.slice(0, start), normalized.slice(end)];
};

try {
  await db.exec(await read('scripts/openrouter-retirement-bootstrap.sql'));
  await db.exec(`ALTER ROLE service_role BYPASSRLS;
    CREATE ROLE first_token_metrics_reader NOLOGIN; CREATE ROLE grafana_cloud NOLOGIN;
    CREATE SCHEMA admin; CREATE SCHEMA app_core;
    CREATE TABLE app_core.runtime_config(key text,value jsonb);
    CREATE TABLE admin.config_drafts(config_key text,value jsonb);
    CREATE TABLE admin.config_releases(config_key text,value jsonb);`);
  for (const name of [
    '20260929_llm_model_catalog_multi_provider.sql',
    '20260929_venice_chat_history.sql',
    '20261015_openrouter_chat_history.sql',
    '20261023_chat_first_token_fallback.sql',
    '20261023_chat_first_token_fallback_config.sql',
    '20261026_first_token_stage_budgets.sql',
    '20261026_first_token_nonretryable_conflicts.sql',
    '20261028_first_token_race.sql',
    '20261030_chat_generation_dispatch_prepare.sql',
  ]) {
    if (name === '20261030_chat_generation_dispatch_prepare.sql') {
      await db.exec(
        'ALTER TABLE experience.chat_generation_requests ADD COLUMN recoverable_delivery boolean NOT NULL DEFAULT false'
      );
    }
    await db.exec(await read(`${migrationPath}${name}`));
  }
  const baseline = await snapshot();
  const installed = await deliveryDefinition();
  const compat = await read(compatPath);
  for (const [installedLabel, installedFormat] of [
    ['LF', lf],
    ['CRLF', crlf],
  ]) {
    for (const [sourceLabel, sourceFormat] of [
      ['LF', lf],
      ['CRLF', crlf],
    ]) {
      await db.exec('BEGIN');
      try {
        await db.exec(installedFormat(installed));
        await db.exec(body(sourceFormat(compat)));
        assert.deepEqual(
          identities((await db.query(functionQuery)).rows),
          identities(baseline.functions)
        );
        assert.deepEqual(untouched(await deliveryDefinition()), untouched(installed));
        const first = await deliveryDefinition();
        await db.exec(body(sourceFormat(compat)));
        assert.equal(await deliveryDefinition(), first, 'Replay changed delivery function');
      } finally {
        await db.exec('ROLLBACK');
      }
      assert.deepEqual(
        await snapshot(),
        baseline,
        'Format scenario rollback changed installed shape'
      );
      console.log(
        `PASS: installed ${installedLabel}, submitted ${sourceLabel}; replay, identity, untouched guards`
      );
    }
  }
  const unknown = lf(installed).replace(
    "IF a.provider='openrouter' THEN",
    "IF a.provider='unknown' THEN"
  );
  assert.notEqual(unknown, lf(installed), 'Negative mutation failed to match');
  for (const [label, definition, source] of [
    ['original CRLF reproduction', installed, crlf(original)],
    ['unknown installed provider branch', unknown, compat],
  ]) {
    await db.exec('BEGIN');
    try {
      await db.exec(definition);
      await assert.rejects(
        db.exec(body(source)),
        (error) =>
          error.code === 'P0001' &&
          error.message === 'Unexpected installed delivery provider branch'
      );
    } finally {
      await db.exec('ROLLBACK');
    }
    assert.deepEqual(await snapshot(), baseline, 'Rejected scenario changed installed shape');
    console.log(
      `PASS: ${label} refused; table, function identity/body, provider constraints rolled back`
    );
  }
  // Some environments may already have applied the historical LF source.
  // Populate its table before applying the distinct compatibility migration.
  await db.exec(lf(original));
  await db.exec(await read(`${migrationPath}tests/surplusintelligence_chat_history.sql`));
  const originalInstalled = await snapshot();
  const rowDigest = async () =>
    (
      await db.query(`SELECT md5(COALESCE(
    jsonb_agg(to_jsonb(h) ORDER BY chat_history_id)::text,'[]')) AS digest
    FROM experience.surplusintelligence_chat_history h`)
    ).rows[0].digest;
  const existingRows = await rowDigest();
  await db.exec(crlf(compat));
  await db.exec(lf(compat));
  assert.deepEqual(
    await snapshot(),
    originalInstalled,
    'Compatibility replay changed existing installed shape'
  );
  assert.equal(
    await rowDigest(),
    existingRows,
    'Compatibility migration changed existing call records'
  );
  assert.deepEqual(
    identities((await db.query(functionQuery)).rows),
    identities(baseline.functions)
  );
  assert.equal(
    createHash('sha256')
      .update(await read(originalPath))
      .digest('hex'),
    originalHash
  );
  console.log(
    'PASS: original LF already applied, compat CRLF/replay preserve populated call table and installed shape'
  );
  console.log(
    'PASS: existing synthetic Surplus scenarios and original migration checksum preserved'
  );
  console.log(
    'Limit: isolated PGlite only; PG17/PostgREST, multi-connection and real provider validation remain separate'
  );
} finally {
  await db.close();
}
