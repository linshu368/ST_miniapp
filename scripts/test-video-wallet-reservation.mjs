// Isolated PostgreSQL/WASM regression for the wallet/video migration interaction.
// Pass the existing local PGlite module path; no credentials or remote writes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('Pass the local PGlite module path');
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const db = new PGlite();
const migration = (name) => readFile(`packages/shared/migrations/${name}.sql`, 'utf8');
const video = await migration('20261027_media_plaza_video');
const patch = await migration('20261117_media_plaza_video_wallet_entry_guard');
const fixture = await readFile(
  'packages/shared/migrations/fixtures/vip_billing_t2_harness.sql',
  'utf8'
);
await db.exec(
  fixture
    .split('CREATE TABLE IF NOT EXISTS billing.payment_orders')[0]
    .replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', '')
);
await db.exec(`
  ALTER TABLE billing.wallet_ledger ADD COLUMN debit_key TEXT UNIQUE;
  ALTER TABLE billing.wallet_ledger DROP CONSTRAINT wallet_ledger_entry_type_check;
  ALTER TABLE billing.wallet_ledger ADD CHECK (entry_type IN
    ('chat_debit','image_generation','refund','media_plaza_video_reserve','media_plaza_video_refund'));
  CREATE SCHEMA media_plaza;
  CREATE TABLE media_plaza.image_plaza_conversations(id UUID PRIMARY KEY);
  CREATE TABLE media_plaza.image_plaza_messages(id UUID PRIMARY KEY);
  CREATE TABLE media_plaza.image_plaza_reference_assets(id UUID PRIMARY KEY);
`);
const schema = await migration('20260921_vip_billing_schema');
await db.exec(schema.match(/CREATE TABLE billing.wallet_refunds \([\s\S]*?\n\);/)[0]);
await db.exec(await migration('20260921_wallet_debit_refund'));
await db.exec(await migration('20261111_light_text_bonus_first_debit'));
for (const name of ['video_quotes', 'video_attempts']) {
  await db.exec(
    video.match(new RegExp(`CREATE TABLE media_plaza.${name} \\([\\s\\S]*?\\n\\);`))[0]
  );
}
for (const name of ['reserve', 'refund']) {
  await db.exec(
    video.match(
      new RegExp(
        `CREATE OR REPLACE FUNCTION billing.${name}_media_plaza_video\\([\\s\\S]*?\\n\\$\\$;`
      )
    )[0]
  );
}
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const user = '11111111-1111-4111-8111-111111111111';
await db.query('INSERT INTO app_core.users(id) VALUES($1)', [user]);
await db.query(
  'INSERT INTO billing.user_wallets(user_id,main_credits,bonus_credits) VALUES($1,100,20)',
  [user]
);
await db.exec(`
  INSERT INTO media_plaza.image_plaza_conversations VALUES('${user}');
  INSERT INTO media_plaza.image_plaza_messages VALUES('${user}');
  INSERT INTO media_plaza.video_quotes(id,user_id,model_id,provider_model_id,input_mode,duration_s,
    resolution,audio,credits,catalog_version,expires_at)
  VALUES('${user}','${user}','fixture','fixture','t2v',5,'720p',false,30,1,now()+interval '1 hour');
`);
async function attempt() {
  return (
    await scalar(
      `INSERT INTO media_plaza.video_attempts(user_id,conversation_id,user_message_id,
    assistant_message_id,quote_id,idempotency_key,prompt,model_id,provider_model_id,input_mode,
    duration_s,resolution,audio,quote_credits)
    VALUES($1,$1,$1,$1,$1,gen_random_uuid(),'fictional','fixture','fixture','t2v',5,'720p',false,30)
    RETURNING id`,
      [user]
    )
  ).id;
}
const reserve = (id) =>
  scalar('SELECT billing.reserve_media_plaza_video($1,$2) AS result', [id, user]);
const wallet = () =>
  scalar(
    'SELECT main_credits::int main,bonus_credits::int bonus FROM billing.user_wallets WHERE user_id=$1',
    [user]
  );
const snapshot = () =>
  scalar(`SELECT oid::int,proowner::int,proacl::text,proconfig,prosrc
  FROM pg_proc WHERE oid='billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)'::regprocedure`);
const id = await attempt();
await assert.rejects(() => reserve(id), /INVALID_AMOUNT/);
assert.deepEqual(await wallet(), { main: 100, bonus: 20 });
const before = await snapshot();
await db.exec(patch);
const after = await snapshot();
assert.deepEqual({ ...after, prosrc: '' }, { ...before, prosrc: '' });
await db.exec(patch);
assert.deepEqual(await snapshot(), after);
await db.exec(
  await readFile(
    'packages/shared/migrations/tests/20261117_media_plaza_video_wallet_entry_guard.sql',
    'utf8'
  )
);
assert.equal((await reserve(id)).result.status, 'reserved');
assert.equal((await reserve(id)).result.status, 'already_reserved');
assert.deepEqual(await wallet(), { main: 90, bonus: 0 });
assert.equal(
  (
    await scalar(
      "SELECT count(*)::int n FROM billing.wallet_ledger WHERE entry_type='media_plaza_video_reserve'"
    )
  ).n,
  1
);
for (let i = 0; i < 2; i++) {
  await db.query("SELECT billing.refund_media_plaza_video($1,'fixture_failure')", [id]);
}
assert.deepEqual(await wallet(), { main: 100, bonus: 20 });
assert.equal((await scalar('SELECT count(*)::int n FROM billing.wallet_refunds')).n, 1);
const debit = (key, policy, amount, type) =>
  scalar(`SELECT billing.apply_wallet_debit($1,$2,$3,$4,$5,'fixture',$2) AS result`, [
    user,
    key,
    policy,
    amount,
    type,
  ]);
await debit('chat', 'main_then_bonus', 10, 'chat_debit');
assert.deepEqual(await wallet(), { main: 100, bonus: 10 });
await debit('image', 'main_only', 10, 'image_generation');
assert.deepEqual(await wallet(), { main: 90, bonus: 10 });
await assert.rejects(() => debit('invalid', 'main_only', 10, 'arbitrary_type'), /INVALID_AMOUNT/);
await assert.rejects(
  () => debit('insufficient', 'main_then_bonus', 1000, 'media_plaza_video_reserve'),
  /TOTAL_CREDITS_INSUFFICIENT/
);
assert.deepEqual(await wallet(), { main: 90, bonus: 10 });
const insufficient = await attempt();
await db.query('UPDATE billing.user_wallets SET main_credits=0,bonus_credits=0 WHERE user_id=$1', [
  user,
]);
assert.equal((await reserve(insufficient)).result.status, 'insufficient_balance');
assert.deepEqual(await wallet(), { main: 0, bonus: 0 });
for (const role of ['anon', 'authenticated']) {
  assert.equal(
    (
      await scalar(
        `SELECT has_function_privilege($1,
    'billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)','EXECUTE') AS allowed`,
        [role]
      )
    ).allowed,
    false
  );
}
assert.equal(
  (
    await scalar(`SELECT has_function_privilege('service_role',
  'billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)','EXECUTE') AS allowed`)
  ).allowed,
  true
);

// An unreviewed future guard is never overwritten, even if the rest of the function is familiar.
const currentDef = (
  await scalar(`SELECT pg_get_functiondef(
  'billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)'::regprocedure) AS body`)
).body;
await db.exec(
  currentDef.replace(
    "'media_plaza_video_reserve') THEN",
    "'media_plaza_video_reserve', 'fixture_future') THEN"
  )
);
const future = await snapshot();
await assert.rejects(() => db.exec(patch), /unknown or duplicate entry guard/);
await db.exec('ROLLBACK');
assert.deepEqual(await snapshot(), future);
await db.close();
console.log(
  'PASS: video reserve/refund, replay, insufficient funds, bonus-first/main-only, ACL and unknown-shape rejection'
);
