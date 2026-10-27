import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(resolve(root, 'packages/backend/package.json'));
const { Client } = require('pg');
const { parse } = require('dotenv');
const TEST_REF = 'zoqelpfhurwehlvypryl';
const templatePath = resolve(
  root,
  'packages/shared/migrations/20261019_image_plaza_seed_bootstrap.sql'
);
const marker = '__SEED_PAYLOAD_HEX__';
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(
      'node scripts/export-image-plaza-seed.mjs [--env-file ABS_PATH] [--output ABS_DIR]'
    );
    console.log('Only TEST_DATABASE_URL is used. READ ONLY; never connects to production.');
    return;
  }
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--env-file', '--output'].includes(args[i]) || !args[i + 1] || options.has(args[i])) {
      throw new Error('invalid_arguments');
    }
    options.set(args[i], args[i + 1]);
  }
  const envPath = resolve(options.get('--env-file') ?? resolve(root, 'packages/backend/.env'));
  const output = resolve(
    options.get('--output') ?? resolve(root, 'ops/exports', `civitai-${Date.now()}`)
  );
  const exportsRoot = resolve(root, 'ops/exports');
  const within = relative(exportsRoot, output);
  if (!within || within.startsWith('..') || isAbsolute(within))
    throw new Error('output_must_be_under_ops_exports');
  execFileSync('git', ['check-ignore', '--quiet', '--', resolve(output, 'seed.sql')], {
    cwd: root,
    stdio: 'pipe',
  });
  const env = parse(await readFile(envPath));
  const connectionString = process.env.TEST_DATABASE_URL || env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL_missing');
  const url = new URL(connectionString);
  const direct = url.hostname === `db.${TEST_REF}.supabase.co`;
  const pooler =
    url.hostname.endsWith('.pooler.supabase.com') &&
    decodeURIComponent(url.username) === `postgres.${TEST_REF}`;
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || (!direct && !pooler)) {
    throw new Error('not_the_approved_TEST_project');
  }
  if (
    url.searchParams.get('sslmode') === 'disable' ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  ) {
    throw new Error('TLS_verification_must_not_be_disabled');
  }
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 20000,
    statement_timeout: 120000,
  });
  let rows;
  let shape;
  let counts;
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL lock_timeout = '5s'");
    shape = (
      await client.query(`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns WHERE table_schema = 'experience'
        AND table_name IN ('image_plaza_works', 'image_plaza_artifacts')
      ORDER BY table_name, ordinal_position`)
    ).rows;
    counts = (
      await client.query(`SELECT
      count(*) FILTER (WHERE deleted_at IS NULL)::INTEGER AS active,
      count(*) FILTER (WHERE deleted_at IS NOT NULL)::INTEGER AS deleted
      FROM media_plaza.image_plaza_works WHERE origin = 'civitai_seed'`)
    ).rows[0];
    if (counts.active < 1 || counts.active > 20000)
      throw new Error('active_seed_count_outside_capacity');
    const invalid = (
      await client.query(`SELECT count(*)::INTEGER AS count
      FROM media_plaza.image_plaza_works w
      LEFT JOIN media_plaza.image_plaza_artifacts a ON a.id = w.artifact_id
      WHERE w.origin = 'civitai_seed' AND w.deleted_at IS NULL AND (
        a.id IS NULL OR a.origin IS DISTINCT FROM 'civitai_seed'
        OR a.source_platform IS DISTINCT FROM 'civitai' OR w.source_platform IS DISTINCT FROM 'civitai'
        OR a.source_image_id IS DISTINCT FROM w.source_image_id
        OR w.user_id IS NOT NULL OR w.attempt_id IS NOT NULL OR a.attempt_id IS NOT NULL
        OR a.position <> 0 OR w.width <> a.width OR w.height <> a.height)`)
    ).rows[0].count;
    if (invalid !== 0) throw new Error('seed_relation_invariant_failed');
    rows = (
      await client.query(`SELECT
      w.source_image_id, w.source_image_url, w.source_heat, w.title, w.model_id,
      w.model_name, w.width, w.height, w.tags, w.snapshot,
      to_char(w.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS published_at,
      a.storage_path, a.mime_type, a.byte_size
      FROM media_plaza.image_plaza_works w
      JOIN media_plaza.image_plaza_artifacts a ON a.id = w.artifact_id
      WHERE w.origin = 'civitai_seed' AND w.deleted_at IS NULL
      ORDER BY w.source_image_id LIMIT 20001`)
    ).rows;
    await client.query('COMMIT');
  } finally {
    // Disconnecting an unsuccessful read-only transaction rolls it back.
    await client.end();
  }
  if (
    rows.length !== counts.active ||
    new Set(rows.map((r) => r.source_image_id)).size !== rows.length
  ) {
    throw new Error('export_count_or_uniqueness_mismatch');
  }
  for (const row of rows) {
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[row.mime_type];
    if (
      !/^\d+$/.test(row.source_image_id) ||
      !ext ||
      row.storage_path !== `image-plaza/imports/civitai/${row.source_image_id}.${ext}` ||
      !Number.isInteger(row.byte_size) ||
      row.byte_size < 1 ||
      row.byte_size > 52428800 ||
      !Array.isArray(row.tags) ||
      row.tags.some((tag) => typeof tag !== 'string') ||
      !row.snapshot ||
      typeof row.snapshot.prompt !== 'string'
    ) {
      throw new Error('seed_content_invariant_failed');
    }
  }
  const payload = JSON.stringify(rows);
  const template = await readFile(templatePath, 'utf8');
  if (template.split(marker).length !== 2) throw new Error('template_marker_invalid');
  const sql = template.replace(marker, Buffer.from(payload, 'utf8').toString('hex'));
  const manifest =
    JSON.stringify(
      {
        source_project_ref: TEST_REF,
        bucket: 'image-plaza',
        objects: rows.map((r) => ({
          source_image_id: r.source_image_id,
          path: r.storage_path,
          mime_type: r.mime_type,
          byte_size: r.byte_size,
          width: r.width,
          height: r.height,
        })),
      },
      null,
      2
    ) + '\n';
  const summary = {
    exported_at: new Date().toISOString(),
    source_project_ref: TEST_REF,
    source_read_only: true,
    production_written: false,
    works: rows.length,
    artifacts: rows.length,
    excluded_deleted_works: counts.deleted,
    image_bytes: rows.reduce((sum, r) => sum + r.byte_size, 0),
    sql_bytes: Buffer.byteLength(sql),
    sql_sha256: hash(sql),
    payload_sha256: hash(payload),
    storage_manifest_sha256: hash(manifest),
    template_sha256: hash(template),
    source_shape: shape,
  };
  await mkdir(exportsRoot, { recursive: true });
  await mkdir(output); // A previous run is evidence; never overwrite it.
  await writeFile(resolve(output, 'seed.sql'), sql, { flag: 'wx', mode: 0o600 });
  await writeFile(resolve(output, 'storage-manifest.json'), manifest, { flag: 'wx', mode: 0o600 });
  // Written last: absence of summary means incomplete export, not an executable deliverable.
  await writeFile(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      output,
      works: rows.length,
      image_bytes: summary.image_bytes,
      sql_sha256: summary.sql_sha256,
    })
  );
}

main().catch((err) => {
  // pg errors can contain row values or credentials: never print message/detail/stack.
  console.error(
    JSON.stringify({
      event: 'seed_export_failed',
      code: typeof err.code === 'string' ? err.code : 'VALIDATION_OR_IO_ERROR',
    })
  );
  process.exitCode = 1;
});
