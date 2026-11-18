// Isolated PostgreSQL/WASM assertions. Pass an installed @electric-sql/pglite/dist/index.js path.
// No credentials, network, remote database, or business data are used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('Pass the local PGlite module path');
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const db = new PGlite();
const baseline = await readFile(
  'packages/shared/migrations/20261027_media_plaza_video.sql',
  'utf8'
);
const expand = await readFile(
  'packages/shared/migrations/20261117_media_plaza_stream_delivery.sql',
  'utf8'
);
const contract = await readFile(
  'packages/shared/migrations/20261117_media_plaza_stream_contract.sql',
  'utf8'
);
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const call = (name, args) =>
  db.query(`select media_plaza.${name}(${args.map((_, i) => `$${i + 1}`).join(',')})`, args);
const uid = (n) => String(n).padStart(32, '0');
const url = (n) => `https://customer-fixture.cloudflarestream.com/${uid(n)}/manifest/video.m3u8`;

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA app_core; CREATE SCHEMA billing; CREATE SCHEMA media_plaza;
  CREATE TABLE app_core.users(id UUID PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE media_plaza.image_plaza_conversations(id UUID PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE media_plaza.image_plaza_messages(id UUID PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE media_plaza.image_plaza_reference_assets(id UUID PRIMARY KEY);
  CREATE TABLE billing.wallet_ledger(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),entry_type TEXT,reference_type TEXT,reference_id TEXT);
  CREATE TABLE billing.test_refunds(dedup TEXT PRIMARY KEY,ledger_id UUID NOT NULL REFERENCES billing.wallet_ledger(id));
  CREATE FUNCTION billing.refund_wallet_debit(p_key TEXT,p_original TEXT,p_reason TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
  DECLARE v_id UUID;
  BEGIN
    SELECT ledger_id INTO v_id FROM billing.test_refunds WHERE dedup=p_key;
    IF FOUND THEN RETURN jsonb_build_object('status','already_refunded','ledger_id',v_id); END IF;
    INSERT INTO billing.wallet_ledger(entry_type) VALUES('refund') RETURNING id INTO v_id;
    INSERT INTO billing.test_refunds VALUES(p_key,v_id);
    RETURN jsonb_build_object('status','refunded','ledger_id',v_id);
  END $$;
  CREATE FUNCTION media_plaza.publish_video_artifact(UUID,TEXT,TEXT,BIGINT,INTEGER,INTEGER,INTEGER,TEXT,INTEGER,INTEGER)
    RETURNS JSONB LANGUAGE sql AS 'select null::jsonb';
  CREATE FUNCTION media_plaza.import_video_seed_work(TEXT,TEXT,INTEGER,TEXT,BIGINT,INTEGER,INTEGER,INTEGER,TEXT,INTEGER,INTEGER,TEXT,TEXT,TEXT,TEXT,JSONB,TIMESTAMPTZ)
    RETURNS JSONB LANGUAGE sql AS 'select null::jsonb';
`);
for (const name of ['video_quotes', 'video_attempts', 'video_artifacts']) {
  const table = baseline.match(new RegExp(`CREATE TABLE media_plaza.${name} \\([\\s\\S]*?\\n\\);`));
  assert.ok(table, name);
  await db.exec(table[0]);
}
const refund = baseline.match(
  /CREATE OR REPLACE FUNCTION billing.refund_media_plaza_video\([\s\S]*?\n\$\$;/
);
assert.ok(refund);
await db.exec(refund[0]);
await db.exec(expand);
await db.exec(`
  INSERT INTO app_core.users VALUES('11111111-1111-4111-8111-111111111111');
  INSERT INTO media_plaza.image_plaza_conversations VALUES('22222222-2222-4222-8222-222222222222');
  INSERT INTO media_plaza.image_plaza_messages VALUES('33333333-3333-4333-8333-333333333333');
  INSERT INTO billing.wallet_ledger(id) VALUES('44444444-4444-4444-8444-444444444444');
  INSERT INTO media_plaza.video_quotes(id,user_id,model_id,provider_model_id,input_mode,duration_s,resolution,audio,credits,catalog_version,expires_at)
    VALUES('55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111','fixture','fixture','t2v',5,'720p',false,10,1,now()+interval '1 hour');
  INSERT INTO media_plaza.video_artifacts(origin,storage_path,byte_size,width,height,duration_ms,source_video_id,source_video_url)
    VALUES('civitai_seed','seed-backup.mp4',128,1280,720,5000,'fixture-seed','https://fixture.invalid/source');
`);

async function attempt() {
  return (
    await scalar(`INSERT INTO media_plaza.video_attempts(user_id,conversation_id,user_message_id,assistant_message_id,quote_id,
    idempotency_key,prompt,model_id,provider_model_id,input_mode,duration_s,resolution,audio,quote_credits,status,
    lease_owner,lease_expires_at,debit_ledger_id,credits_charged,charged_at)
    VALUES('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333','33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555',
    gen_random_uuid(),'fictional','fixture','fixture','t2v',5,'720p',false,10,'processing','worker',now()+interval '1 minute',
    '44444444-4444-4444-8444-444444444444',10,now()) RETURNING id`)
  ).id;
}
async function enqueue(id) {
  await call('enqueue_video_delivery', [id, 'worker', null]);
  await call('enqueue_video_delivery', [id, 'worker', null]);
  assert.equal(
    (
      await scalar(
        'select count(*)::int as n from media_plaza.video_delivery_jobs where attempt_id=$1',
        [id]
      )
    ).n,
    1
  );
  return (await db.query('select * from media_plaza.claim_video_delivery_jobs(2)')).rows.find(
    (j) => j.attempt_id === id
  );
}
async function encode(job, n) {
  await db.query(
    "update media_plaza.video_delivery_jobs set stage='encoding',stream_uid=$2,source_byte_size=128 where id=$1",
    [job.id, uid(n)]
  );
}
const publish = (id, token, n) =>
  call('publish_video_artifact', [
    id,
    token,
    uid(n),
    url(n),
    128,
    1280,
    720,
    5000,
    'poster.jpg',
    720,
    405,
  ]);

// Fencing and replay: stale writers cannot publish, and success cannot later refund.
const first = await attempt();
const job = await enqueue(first);
assert.ok(job.lease_token);
await encode(job, 1);
await assert.rejects(() => publish(first, '00000000-0000-4000-8000-000000000000', 1), /lease lost/);
await publish(first, job.lease_token, 1);
await publish(first, job.lease_token, 1);
await call('fail_video_delivery', [first, job.lease_token, 'fixture_failure', false]);
assert.equal(
  (
    await scalar('select count(*)::int n from media_plaza.video_artifacts where attempt_id=$1', [
      first,
    ])
  ).n,
  1
);
assert.equal((await scalar('select count(*)::int n from billing.test_refunds')).n, 0);

// A deterministic failure refunds once and closes the race against a delayed publication.
const second = await attempt();
const failed = await enqueue(second);
await encode(failed, 2);
await call('fail_video_delivery', [second, failed.lease_token, 'fixture_encode_failed', false]);
await call('fail_video_delivery', [second, failed.lease_token, 'fixture_encode_failed', false]);
await assert.rejects(() => publish(second, failed.lease_token, 2), /lease lost/);
assert.equal((await scalar('select count(*)::int n from billing.test_refunds')).n, 1);

// Unknown creation is quarantined with no refund or automatic re-claim.
const third = await attempt();
const unknown = await enqueue(third);
await call('fail_video_delivery', [third, unknown.lease_token, 'fixture_creation_unknown', true]);
assert.equal(
  (await scalar('select stage from media_plaza.video_delivery_jobs where id=$1', [unknown.id]))
    .stage,
  'unknown'
);
assert.equal(
  (await db.query('select * from media_plaza.claim_video_delivery_jobs(4)')).rows.length,
  0
);
assert.equal((await scalar('select count(*)::int n from billing.test_refunds')).n, 1);

// A renewed lease fences the previous worker even if it finishes after recovery.
const fourth = await attempt();
const old = await enqueue(fourth);
await encode(old, 4);
await db.query(
  "update media_plaza.video_delivery_jobs set lease_expires_at=now()-interval '1 second' where id=$1",
  [old.id]
);
await assert.rejects(
  () => call('fail_video_delivery', [fourth, old.lease_token, 'fixture_expired', false]),
  /lease lost/
);
const renewed = (await db.query('select * from media_plaza.claim_video_delivery_jobs(1)')).rows[0];
assert.notEqual(renewed.lease_token, old.lease_token);
await assert.rejects(() => publish(fourth, old.lease_token, 4), /lease lost/);
await publish(fourth, renewed.lease_token, 4);

// Browser roles have no table/function capabilities. service_role has explicit worker access.
assert.equal(
  (
    await scalar(
      "select has_table_privilege('authenticated','media_plaza.video_delivery_jobs','SELECT') as allowed"
    )
  ).allowed,
  false
);
assert.equal(
  (
    await scalar(
      "select has_function_privilege('anon','media_plaza.claim_video_delivery_jobs(integer)','EXECUTE') as allowed"
    )
  ).allowed,
  false
);
assert.equal(
  (
    await scalar(
      "select has_function_privilege('service_role','media_plaza.claim_video_delivery_jobs(integer)','EXECUTE') as allowed"
    )
  ).allowed,
  true
);

// Contraction fails atomically while a legacy asset remains; after mapping it, real DROP works.
await assert.rejects(() => db.exec(contract), /incomplete/);
await db.exec('ROLLBACK');
assert.equal(
  (
    await scalar(
      "select count(*)::int n from information_schema.columns where table_schema='media_plaza' and table_name='video_artifacts' and column_name='storage_path'"
    )
  ).n,
  1
);
await db.query(
  "update media_plaza.video_artifacts set stream_uid=$1,playback_url=$2 where origin='civitai_seed'",
  [uid(9), url(9)]
);
await db.exec(contract);
const fifth = await attempt();
const postContract = await enqueue(fifth);
await encode(postContract, 5);
await publish(fifth, postContract.lease_token, 5);
assert.equal(
  (
    await scalar(
      "select count(*)::int n from information_schema.columns where table_schema='media_plaza' and table_name='video_artifacts' and column_name='storage_path'"
    )
  ).n,
  0
);
await db.close();
// Exercise the generated 13-row data migration, including all-or-nothing CAS and replay.
const migration = await readFile(
  'packages/shared/migrations/20261117_media_plaza_stream_test_assets.sql',
  'utf8'
);
const payloadHex = migration.match(/decode\('([a-f0-9]+)','hex'\)/)?.[1];
assert.ok(payloadHex);
const payload = JSON.parse(Buffer.from(payloadHex, 'hex').toString());
assert.equal(payload.length, 13);
const mappingDb = new PGlite();
await mappingDb.exec(
  'CREATE SCHEMA media_plaza; CREATE TABLE media_plaza.video_artifacts(id UUID PRIMARY KEY,storage_path TEXT,byte_size BIGINT,stream_uid TEXT,playback_url TEXT);'
);
for (const row of payload)
  await mappingDb.query('insert into media_plaza.video_artifacts values($1,$2,$3,null,null)', [
    row.id,
    row.path,
    row.bytes,
  ]);
await assert.rejects(() => mappingDb.exec(migration), /TEST identity/);
await mappingDb.exec('ROLLBACK');
await mappingDb.query(
  "select set_config('app.seed_target','test',false),set_config('app.seed_project_ref','zoqelpfhurwehlvypryl',false),set_config('app.seed_storage_verified','yes',false)"
);
await mappingDb.query('update media_plaza.video_artifacts set byte_size=1 where id=$1', [
  payload.at(-1).id,
]);
await assert.rejects(() => mappingDb.exec(migration), /compare-and-swap/);
await mappingDb.exec('ROLLBACK');
assert.equal(
  (
    await mappingDb.query(
      'select count(*)::int n from media_plaza.video_artifacts where stream_uid is not null'
    )
  ).rows[0].n,
  0
);
await mappingDb.query('update media_plaza.video_artifacts set byte_size=$2 where id=$1', [
  payload.at(-1).id,
  payload.at(-1).bytes,
]);
await mappingDb.exec(migration);
await mappingDb.exec(migration);
assert.equal(
  (
    await mappingDb.query(
      'select count(distinct stream_uid)::int n from media_plaza.video_artifacts'
    )
  ).rows[0].n,
  13
);
await mappingDb.close();
console.log(
  'PASS: real PostgreSQL/WASM expand/contract, fencing, replay, refunds, unknown quarantine and browser ACL. Multi-connection concurrency requires TEST PostgreSQL validation.'
);
