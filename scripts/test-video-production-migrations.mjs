// Offline PG17/WASM upgrade regression. No credentials, network or remote writes.
// Argument 2: installed PGlite entry. Optional argument 3: reviewed external seed directory.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('Pass the local PGlite module path');
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const db = new PGlite();
const migration = (name) => readFile(`packages/shared/migrations/${name}.sql`, 'utf8');
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const base = await migration('20261118_media_plaza_video_production_base');
const config = await migration('20261118_media_plaza_video_production_config');
const user = '11111111-1111-4111-8111-111111111111';

async function fixture() {
  const vip = await migration('fixtures/vip_billing_t2_harness');
  await db.exec(
    vip
      .split('CREATE TABLE IF NOT EXISTS billing.payment_orders')[0]
      .replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', '')
  );
  await db.exec(`ALTER TABLE billing.wallet_ledger ADD COLUMN debit_key TEXT UNIQUE;
    CREATE SCHEMA media_plaza; CREATE SCHEMA admin; CREATE SCHEMA storage;
    CREATE TABLE storage.buckets(id TEXT PRIMARY KEY,name TEXT,public BOOLEAN,
      file_size_limit BIGINT,allowed_mime_types TEXT[]);
    CREATE TABLE storage.objects(bucket_id TEXT,name TEXT,metadata JSONB,PRIMARY KEY(bucket_id,name));
    INSERT INTO storage.buckets VALUES('media-plaza-video','existing',false,20971520,ARRAY['image/jpeg']);
    CREATE TABLE admin.managed_config_keys(config_key TEXT PRIMARY KEY,managed_via TEXT NOT NULL,
      retired_at TIMESTAMPTZ,note TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    INSERT INTO admin.managed_config_keys(config_key,managed_via) VALUES
      ('fixture_old','operations_config'),('drive_mode_options','operations_config'),('retired','operations_config');
    UPDATE admin.managed_config_keys SET retired_at=now() WHERE config_key='retired';
    CREATE TABLE admin.config_drafts(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      config_key TEXT NOT NULL REFERENCES admin.managed_config_keys(config_key));
    CREATE TABLE admin.config_releases(LIKE admin.config_drafts INCLUDING ALL);
    ALTER TABLE admin.config_releases ADD FOREIGN KEY(config_key) REFERENCES admin.managed_config_keys(config_key);
    CREATE FUNCTION admin.validate_managed_config_value_before_drive_mode(TEXT,JSONB,TEXT) RETURNS VOID
      LANGUAGE plpgsql AS $$ BEGIN
      IF $1 IS DISTINCT FROM 'fixture_old' OR jsonb_typeof($2) IS DISTINCT FROM 'object' OR $3 IS NOT NULL
        THEN RAISE EXCEPTION 'fixture old validator rejection' USING ERRCODE='22023'; END IF;
      END $$;`);
  const schema = await migration('20260921_vip_billing_schema');
  await db.exec(schema.match(/CREATE TABLE billing.wallet_refunds \([\s\S]*?\n\);/)[0]);
  await db.exec(await migration('20260921_wallet_debit_refund'));
  await db.exec(await migration('20261111_light_text_bonus_first_debit'));
  await db.exec(
    vip.match(/CREATE OR REPLACE FUNCTION billing.grant_bonus_credits\([\s\S]*?\n\$\$;/)[0]
  );
  const image = (await migration('20261012_image_plaza_v2')).replaceAll(
    'experience.',
    'media_plaza.'
  );
  for (const name of [
    'conversations',
    'messages',
    'quotes',
    'reference_assets',
    'attempts',
    'artifacts',
    'works',
  ]) {
    await db.exec(
      image.match(
        new RegExp(`CREATE TABLE media_plaza.image_plaza_${name} \\([\\s\\S]*?\\n\\);`)
      )[0]
    );
  }
  await db.exec(image.match(/CREATE TABLE billing.image_plaza_share_rewards \([\s\S]*?\n\);/)[0]);
  const seed = (await migration('20261013_image_plaza_seed_catalog'))
    .replaceAll('\r\n', '\n')
    .replaceAll('experience.', 'media_plaza.');
  for (const name of ['artifacts', 'works']) {
    await db.exec(
      seed.match(new RegExp(`ALTER TABLE media_plaza.image_plaza_${name}\\n[\\s\\S]*?;`))[0]
    );
  }
  await db.exec(`ALTER TABLE media_plaza.image_plaza_works ADD COLUMN initial_feed_order BIGINT UNIQUE
    CHECK(initial_feed_order>0);`);
  await db.exec(await migration('fixtures/video_production_catalog'));
  await db.exec(`INSERT INTO app_core.users(id) VALUES('${user}');
    INSERT INTO billing.user_wallets(user_id,main_credits,bonus_credits) VALUES('${user}',100,20);
    INSERT INTO media_plaza.image_plaza_conversations(id,user_id,title) VALUES('${user}','${user}','fixture');
    INSERT INTO media_plaza.image_plaza_messages(id,conversation_id,role) VALUES('${user}','${user}','user');
    INSERT INTO media_plaza.image_plaza_artifacts(id,position,storage_path,mime_type,byte_size,width,height,
      origin,source_platform,source_image_id) VALUES('${user}',0,'fixture.jpg','image/jpeg',10,1,1,'civitai_seed','civitai','1');
    INSERT INTO media_plaza.image_plaza_works(artifact_id,title,model_id,model_name,width,height,snapshot,
      origin,source_platform,source_image_id,source_image_url,source_heat) VALUES('${user}','fixture','fixture',
      'fixture',1,1,'{}','civitai_seed','civitai','1','https://image.civitai.com/fixture',1);
    INSERT INTO billing.wallet_ledger(user_id,entry_type,amount,balance_main,balance_bonus)
      SELECT '${user}',t,1,100,20 FROM unnest(ARRAY['creator_reward','creator_reward_reversal','survey_reward']) t;`);
}

async function rejected(sql, pattern) {
  await assert.rejects(() => db.exec(sql), pattern);
  await db.exec('ROLLBACK');
}
const shape = () =>
  scalar(`SELECT
  to_regclass('media_plaza.video_quotes')::text AS quotes,
  (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='media_plaza'
    AND table_name='image_plaza_works' AND column_name='media_type') AS columns`);
const proc = () =>
  scalar(`SELECT oid::int,proowner::int,proacl::text,proconfig,prosrc FROM pg_proc
  WHERE oid='billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)'::regprocedure`);

async function baseChecks() {
  const bucket = await scalar("SELECT * FROM storage.buckets WHERE id='media-plaza-video'");
  await db.exec(
    'BEGIN; ALTER TABLE billing.wallet_ledger VALIDATE CONSTRAINT wallet_ledger_entry_type_check; COMMIT;'
  );
  await rejected(base, /wallet type constraint differs/);
  assert.deepEqual(await shape(), { quotes: null, columns: 0 });
  await db.exec(
    `ALTER TABLE billing.wallet_ledger DROP CONSTRAINT wallet_ledger_entry_type_check;`
  );
  // Reset only the fixture predicate; source catalog is never needed at test runtime.
  const catalog = await migration('fixtures/video_production_catalog');
  await db.exec(
    catalog.slice(
      catalog.indexOf('ALTER TABLE billing.wallet_ledger ADD'),
      catalog.indexOf('CREATE OR REPLACE FUNCTION')
    )
  );
  await db.exec("UPDATE storage.buckets SET public=true WHERE id='media-plaza-video'");
  await rejected(base, /cover bucket is incompatible/);
  await db.exec("UPDATE storage.buckets SET public=false WHERE id='media-plaza-video'");
  await db.exec('ALTER TABLE media_plaza.image_plaza_messages ADD COLUMN media_type TEXT');
  await rejected(base, /already or partially provisioned/);
  await db.exec('ALTER TABLE media_plaza.image_plaza_messages DROP COLUMN media_type');
  const original = await scalar(`SELECT pg_get_functiondef(
    'billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)'::regprocedure) AS body`);
  await db.exec(
    original.body.replace(
      "'chat_debit', 'image_generation') THEN",
      "'chat_debit', 'image_generation', 'fixture_future') THEN"
    )
  );
  await rejected(base, /unknown or duplicate entry guard/);
  assert.deepEqual(await shape(), { quotes: null, columns: 0 });
  await db.exec(original.body);
  const before = await proc();
  await db.exec(base);
  const after = await proc();
  assert.deepEqual({ ...before, prosrc: '' }, { ...after, prosrc: '' });
  assert.equal(
    after.prosrc,
    before.prosrc.replace(
      "'chat_debit', 'image_generation') THEN",
      "'chat_debit', 'image_generation', 'media_plaza_video_reserve') THEN"
    )
  );
  assert.deepEqual(
    await scalar("SELECT * FROM storage.buckets WHERE id='media-plaza-video'"),
    bucket
  );
  assert.equal(
    (
      await scalar(`SELECT convalidated FROM pg_constraint WHERE conrelid='billing.wallet_ledger'::regclass
    AND conname='wallet_ledger_entry_type_check'`)
    ).convalidated,
    false
  );
  await rejected(base, /already or partially provisioned/);
  await assert.rejects(
    () => db.exec(`UPDATE media_plaza.image_plaza_works SET source_image_id=NULL`),
    /check constraint/
  );
  assert.equal((await scalar('SELECT count(*)::int n FROM media_plaza.image_plaza_works')).n, 1);
  for (const role of ['anon', 'authenticated']) {
    const acl = await scalar(
      `SELECT bool_or(has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE')) AS tables,
      bool_or(NOT c.relrowsecurity) AS no_rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='media_plaza' AND c.relname IN ('video_quotes','video_attempts','video_artifacts')`,
      [role]
    );
    assert.deepEqual(acl, { tables: false, no_rls: false });
  }
}

async function walletChecks() {
  await db.exec(`INSERT INTO media_plaza.video_quotes(id,user_id,model_id,provider_model_id,input_mode,
    duration_s,resolution,audio,credits,catalog_version,expires_at)
    VALUES('${user}','${user}','fixture','fixture','t2v',5,'720p',false,30,1,now()+interval '1 hour');`);
  const wallet = () =>
    scalar(
      `SELECT main_credits::int main,bonus_credits::int bonus FROM billing.user_wallets WHERE user_id=$1`,
      [user]
    );
  for (const rate of ['refund', 0, 0.5]) {
    const { id } = await scalar(
      `INSERT INTO media_plaza.video_attempts(user_id,conversation_id,user_message_id,
      assistant_message_id,quote_id,idempotency_key,prompt,model_id,provider_model_id,input_mode,
      duration_s,resolution,audio,quote_credits) VALUES($1,$1,$1,$1,$1,gen_random_uuid(),'fictional',
      'fixture','fixture','t2v',5,'720p',false,30) RETURNING id`,
      [user]
    );
    const reserve = () =>
      scalar('SELECT billing.reserve_media_plaza_video($1,$2) result', [id, user]);
    assert.equal((await reserve()).result.status, 'reserved');
    assert.equal((await reserve()).result.status, 'already_reserved');
    if (rate === 'refund') {
      assert.deepEqual(await wallet(), { main: 90, bonus: 0 });
      for (let i = 0; i < 2; i++)
        await db.query("SELECT billing.refund_media_plaza_video($1,'fixture')", [id]);
      assert.deepEqual(await wallet(), { main: 100, bonus: 20 });
      continue;
    }
    await db.query(
      "UPDATE media_plaza.video_attempts SET status='storing',lease_owner='fixture',lease_expires_at=now()+interval '1 hour' WHERE id=$1",
      [id]
    );
    const artifact = await scalar(
      `SELECT media_plaza.publish_video_artifact($1,'fixture',$2,10::bigint,10,10,5000,'fixture.jpg',10,10) result`,
      [id, `${id}.mp4`]
    );
    const share = () =>
      scalar(
        `SELECT billing.share_media_plaza_video($1,$2,'fixture','fixture','fixture',ARRAY[]::TEXT[],$3) result`,
        [user, artifact.result.artifact_id, rate]
      );
    assert.equal((await share()).result.already_shared, false);
    assert.equal((await share()).result.already_shared, true);
    assert.deepEqual(await wallet(), rate === 0 ? { main: 90, bonus: 0 } : { main: 60, bonus: 15 });
    assert.equal(
      (await scalar('SELECT count(*)::int n FROM billing.image_plaza_share_rewards')).n,
      rate === 0 ? 1 : 2
    );
  }
  await db.query(
    `SELECT billing.apply_wallet_debit($1,'chat','main_then_bonus',10,'chat_debit','fixture','chat')`,
    [user]
  );
  assert.deepEqual(await wallet(), { main: 60, bonus: 5 });
  await db.query(
    `SELECT billing.apply_wallet_debit($1,'image','main_only',10,'image_generation','fixture','image')`,
    [user]
  );
  assert.deepEqual(await wallet(), { main: 50, bonus: 5 });
  await assert.rejects(
    () =>
      db.query(`SELECT billing.apply_wallet_debit($1,'bad','main_only',10,'bad','fixture','bad')`, [
        user,
      ]),
    /INVALID_AMOUNT/
  );
  assert.equal(
    (
      await scalar(
        "SELECT count(*)::int n FROM billing.wallet_ledger WHERE entry_type IN ('creator_reward','creator_reward_reversal','survey_reward')"
      )
    ).n,
    3
  );
  for (const type of ['creator_reward', 'creator_reward_reversal', 'survey_reward']) {
    await db.query("SELECT billing.grant_bonus_credits($1,1,$2,'fixture',$2)", [user, type]);
  }
  assert.deepEqual(await wallet(), { main: 50, bonus: 8 });
}

async function configChecks() {
  await db.exec(
    'ALTER TABLE admin.config_releases DROP CONSTRAINT config_releases_config_key_fkey'
  );
  await rejected(config, /config-key foreign keys differ/);
  assert.equal(
    (
      await scalar(
        "SELECT to_regprocedure('admin.validate_image_plaza_video_model_catalog(jsonb)')::text AS f"
      )
    ).f,
    null
  );
  await db.exec(
    'ALTER TABLE admin.config_releases ADD FOREIGN KEY(config_key) REFERENCES admin.managed_config_keys(config_key)'
  );
  const outer = await scalar(
    "SELECT pg_get_functiondef('admin.validate_managed_config_value(text,jsonb,text)'::regprocedure) AS body"
  );
  await db.exec(outer.body.replace('    BEGIN', '    DECLARE v_fixture INT; BEGIN'));
  await rejected(config, /unknown validator body/);
  assert.equal(
    (
      await scalar(
        "SELECT count(*)::int n FROM admin.managed_config_keys WHERE config_key='image_plaza_video_model_catalog'"
      )
    ).n,
    0
  );
  await db.exec(outer.body);
  await db.exec(config);
  await rejected(config, /already or partially provisioned/);
  const catalog = {
    default_model_id: 'fixture',
    models: [
      {
        id: 'fixture',
        name: 'fixture',
        description: 'fictional',
        image_input: 'none',
        provider_ids: { t2v: 'fixture' },
        durations: [5],
        resolutions: ['720p'],
        aspect_ratios: [],
        audio_configurable: false,
        default_audio: false,
        enabled: true,
        sort_order: 0,
        default_duration: 5,
        default_resolution: '720p',
        price_matrix: { '5|720p|0': 30 },
      },
    ],
  };
  const validate = (key, value, text = null) =>
    db.query('SELECT admin.validate_managed_config_value($1,$2::jsonb,$3)', [
      key,
      JSON.stringify(value),
      text,
    ]);
  await validate('fixture_old', {});
  await validate('drive_mode_options', { modes: [], default_mode_id: 'fixture' });
  await assert.rejects(() => validate('fixture_old', []), /fixture old validator rejection/);
  await assert.rejects(() => validate('drive_mode_options', {}), /drive mode options require/);
  await validate('image_plaza_video_model_catalog', catalog);
  await assert.rejects(
    () => validate('image_plaza_video_model_catalog', catalog, 'text'),
    /must not use text_value/
  );
  await assert.rejects(() => validate('image_plaza_video_model_catalog', null), /invalid shape/);
  const invalid = structuredClone(catalog);
  delete invalid.models[0].image_input;
  await assert.rejects(() => validate('image_plaza_video_model_catalog', invalid), /invalid shape/);
  invalid.models[0].image_input = 'none';
  invalid.models[0].price_matrix = {};
  await assert.rejects(() => validate('image_plaza_video_model_catalog', invalid), /price matrix/);
  await db.exec(`INSERT INTO admin.config_drafts(config_key) VALUES('image_plaza_video_model_catalog');
    INSERT INTO admin.config_releases(config_key) VALUES('image_plaza_video_model_catalog');`);
  await assert.rejects(
    () => db.exec("INSERT INTO admin.config_drafts(config_key) VALUES('unknown')"),
    /foreign key/
  );
}

async function compose() {
  for (const name of [
    '20261028_image_plaza_tag_groups',
    '20261029_media_plaza_image_artifact_video_reference',
    '20261117_media_plaza_stream_delivery',
  ])
    await db.exec(await migration(name));
  assert.equal(
    (
      await scalar(
        "SELECT count(*)::int n FROM media_plaza.image_plaza_works WHERE media_type='image'"
      )
    ).n,
    1
  );
  if (!process.argv[3]) return;
  const directory = resolve(process.argv[3]);
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  let expected = 0;
  let first;
  let firstCover;
  for (const item of manifest.files) {
    assert.match(item.file, /^20261117_media_plaza_video_stream_seed_production_\d{2}\.sql$/);
    const sql = await readFile(resolve(directory, item.file), 'utf8');
    assert.equal(createHash('sha256').update(sql).digest('hex'), item.sha256);
    first ??= sql;
    const rows = [...sql.matchAll(/decode\('([A-Za-z0-9+/=]+)',\s*'base64'\)/g)].flatMap((m) =>
      JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'))
    );
    assert.equal(rows.length, item.rows);
    firstCover ??= rows[0];
    expected += rows.length;
    await db.query(
      `INSERT INTO storage.objects SELECT 'media-plaza-video',r.poster_path,
      jsonb_build_object('mimetype','image/jpeg','size',r.poster_bytes) FROM jsonb_to_recordset($1::jsonb)
      AS r(poster_path TEXT,poster_bytes INT)`,
      [JSON.stringify(rows)]
    );
    await db.exec(sql);
  }
  const count = () =>
    scalar(
      "SELECT count(*)::int n FROM media_plaza.image_plaza_works WHERE media_type='video' AND origin='civitai_seed'"
    );
  assert.equal((await count()).n, expected);
  await db.exec(first);
  assert.equal((await count()).n, expected);
  await db.query('DELETE FROM storage.objects WHERE name=$1', [firstCover.poster_path]);
  await rejected(first, /cover is missing or changed/);
  assert.equal((await count()).n, expected);
  await db.query(
    `INSERT INTO storage.objects VALUES('media-plaza-video',$1,
    jsonb_build_object('mimetype','image/jpeg','size',$2::int))`,
    [firstCover.poster_path, firstCover.poster_bytes]
  );
  await db.query(
    'UPDATE media_plaza.video_artifacts SET byte_size=byte_size+1 WHERE source_video_id=$1',
    [firstCover.source_video_id]
  );
  await rejected(first, /Seed artifact conflict/);
  assert.equal((await count()).n, expected);
  console.log(`PASS: upgrade + Stream + ${expected} reviewed seed rows and replay`);
}

try {
  await fixture();
  await baseChecks();
  await db.exec(await migration('tests/20261118_media_plaza_video_production_base'));
  await walletChecks();
  await configChecks();
  await db.exec(await migration('tests/20261118_media_plaza_video_production_config'));
  await compose();
  console.log(
    'PASS: production bootstrap, money, bonus-first, share, old image rules, config/FK/ACL preservation, rejection/rollback and replay guards'
  );
} catch (err) {
  console.error(`FAIL: ${err.code ?? err.name}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
