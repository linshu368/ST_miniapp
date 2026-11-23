// Disposable PostgreSQL WASM; no credentials, remote data or repo dependency.
// Usage: node scripts/test-chat-wallet-reservations.mjs <external PGlite dist/index.js>
// PGlite serializes transactions. Multi-connection lock scheduling still needs PG17 TEST.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const db = new PGlite();
const migration = (name) => readFile(`packages/shared/migrations/${name}.sql`, 'utf8');
const uid = '11111111-1111-4111-8111-111111111111';
const id = (n) => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
const row = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const expectError = async (fn, code) => {
  await assert.rejects(fn, (error) => error.message.includes(code));
};

async function fixture() {
  const vip = await migration('fixtures/vip_billing_t2_harness');
  await db.exec(
    vip
      .split('CREATE TABLE IF NOT EXISTS billing.payment_orders')[0]
      .replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', '')
  );
  await db.exec(`ALTER TABLE billing.wallet_ledger ADD COLUMN debit_key text UNIQUE;
    CREATE SCHEMA experience; CREATE SCHEMA ops;
    CREATE TABLE experience.chat_history(id uuid PRIMARY KEY,user_id uuid,model text DEFAULT 'a/b',
      session_id uuid,status text DEFAULT 'streaming',llm_charge_id uuid,llm_finish_reason text,
      assistant_reply text,created_at timestamptz DEFAULT now(),turn_index int,revision int);
    CREATE TABLE experience.chat_history_display_metadata(history_id uuid PRIMARY KEY,request_id text,opening_message text);
    CREATE FUNCTION experience.extract_chat_history_display(p_history jsonb)
      RETURNS TABLE(request_id text,opening_message text) LANGUAGE sql AS
      'SELECT p_history#>>''{0,request_id}'',NULL::text';
    CREATE TABLE experience.chat_generation_requests(chat_history_id uuid PRIMARY KEY,client_request_id uuid,mode text,
      request_received_at timestamptz,requested_model_id text,requested_provider text,requested_provider_model_id text,
      catalog_version int,primary_timeout_ms int,first_token_deadline_ms int,timeout_rate_target numeric,
      fallback_model_id text,fallback_timeout_ms int,recoverable_delivery boolean,measurement_method text,
      delivery_attempt_id uuid,requires_visible_token boolean DEFAULT false,client_delivery_failed boolean DEFAULT false,
      first_token_timeout boolean DEFAULT false,server_timeout_stage text,user_stop_billing_enabled boolean DEFAULT false,
      billing_rejected boolean DEFAULT false,client_outcome text,client_reason text,server_first_token_ready_ms numeric,
      client_first_token_visible_ms numeric);
    CREATE TABLE experience.chat_generation_attempts(id uuid PRIMARY KEY,chat_history_id uuid,role text,provider text,
      provider_model_id text,generation_id text);
    CREATE TABLE ops.llm_calls(id uuid PRIMARY KEY,raw_usage jsonb,cost_usd numeric);`);
  const expand = await migration('20261120_db_reorg_p6b1a_usage_charges_expand');
  await db.exec(
    expand.match(/CREATE TABLE IF NOT EXISTS billing\.usage_charges \([\s\S]*?\n\);/)[0]
  );
  // Creator rewards are out of scope for these no-creator quotes. The debit,
  // charge, delivery gate and terminal-result functions below are production definitions.
  await db.exec(`CREATE FUNCTION billing.lock_character_creator_wallets(uuid,jsonb) RETURNS void LANGUAGE sql AS 'SELECT';
    CREATE FUNCTION billing.grant_character_creator_reward(billing.usage_charges) RETURNS void LANGUAGE sql AS 'SELECT';`);
  await db.exec(await migration('fixtures/chat_reservation_production_functions'));
  await db.exec(
    (await migration('20261123_chat_wallet_reservation_columns')).replaceAll(' CONCURRENTLY', '')
  );
  await db.exec(await migration('20261123_chat_wallet_reservations'));
  await db.exec(await migration('20261123_chat_wallet_reservations')); // replay is a no-op
  const index = (await migration('20261123_chat_history_streaming_index')).replaceAll(
    ' CONCURRENTLY',
    ''
  );
  await db.exec(index);
  await db.query('INSERT INTO app_core.users(id) VALUES($1)', [uid]);
  await db.query(
    'INSERT INTO billing.user_wallets(user_id,main_credits,bonus_credits) VALUES($1,10,5)',
    [uid]
  );
}

async function open(n, amount = 10, policy = 'main_then_bonus') {
  await db.query('INSERT INTO experience.chat_history(id,user_id,llm_charge_id) VALUES($1,$2,$1)', [
    id(n),
    uid,
  ]);
  const input = {
    request_id: id(n + 100),
    primary_attempt_id: id(n + 200),
    requested_model_id: 'a/b',
    provider: 'openrouter',
    model: 'a/b',
    received_at: new Date().toISOString(),
    timeout_ms: 4000,
    fallback_timeout_ms: 2000,
    deadline_ms: 10000,
    timeout_rate_target: 0.01,
    catalog_version: 1,
    mode: 'send',
    charge_id: id(n),
    snapshot: {
      charge_id: id(n),
      billing_mode: 'fixed_tier',
      payable_credits: amount,
      wallet_policy: policy,
    },
    history: [{ role: 'system', content: '', request_id: id(n + 100) }],
  };
  await db.query('SELECT experience.begin_chat_generation_observation($1,$2)', [id(n), input]);
  return input;
}
async function held(n) {
  return Number(
    (
      await row(
        'SELECT reserved_main_credits+reserved_bonus_credits AS amount FROM billing.usage_charges WHERE id=$1',
        [id(n)]
      )
    )?.amount ?? 0
  );
}
async function debit(key, amount = 10, entry = 'chat_debit', policy = 'main_then_bonus') {
  return row('SELECT billing.apply_wallet_debit($1,$2,$3,$4,$5,$6,$2,$7) AS result', [
    uid,
    key,
    policy,
    amount,
    entry,
    'llm_usage',
    {},
  ]);
}

try {
  await fixture();
  const input = await open(1);
  assert.equal(await held(1), 10);
  await db.query('SELECT experience.begin_chat_generation_observation($1,$2)', [id(1), input]);
  assert.equal(await held(1), 10, 'admission replay does not reserve twice');
  await expectError(() => open(2), 'TOTAL_CREDITS_INSUFFICIENT');
  assert.equal(await held(2), 0, 'rejected quote and reservation roll back together');
  await expectError(
    () => debit('other-image', 6, 'image_generation'),
    'TOTAL_CREDITS_INSUFFICIENT'
  );
  assert.equal(await held(1), 10, 'other consumption cannot spend the reserved amount');
  await expectError(
    () => db.query('UPDATE billing.user_wallets SET bonus_credits=0 WHERE user_id=$1', [uid]),
    'TOTAL_CREDITS_INSUFFICIENT'
  );
  await debit(id(1));
  assert.equal(await held(1), 0);
  const wallet = await row(
    'SELECT main_credits,bonus_credits FROM billing.user_wallets WHERE user_id=$1',
    [uid]
  );
  assert.deepEqual(wallet, { main_credits: '5.0', bonus_credits: '0.0' });
  await debit(id(1));
  assert.equal(
    Number((await row('SELECT count(*) AS n FROM billing.wallet_ledger')).n),
    1,
    'idempotent debit'
  );

  await db.query(
    'UPDATE billing.user_wallets SET main_credits=30,bonus_credits=0 WHERE user_id=$1',
    [uid]
  );
  await open(3, 10, 'main_only');
  await db.query("UPDATE billing.usage_charges SET status='free',settled_at=now() WHERE id=$1", [
    id(3),
  ]);
  assert.equal(await held(3), 0, 'free terminal releases');
  await open(4);
  await db.query("UPDATE experience.chat_history SET llm_finish_reason='timeout' WHERE id=$1", [
    id(4),
  ]);
  assert.equal(await held(4), 0, 'restart timeout recovery releases');
  await open(5);
  await db.query("UPDATE experience.chat_history SET status='upstream_error' WHERE id=$1", [id(5)]);
  assert.equal(await held(5), 0, 'pre-dispatch failure releases');
  await open(6);
  await db.query(
    "UPDATE experience.chat_history SET llm_finish_reason='user_cancelled',status='stream_interrupted' WHERE id=$1",
    [id(6)]
  );
  assert.equal(await held(6), 10, 'manual stop retains its billing hold');
  await expectError(
    () =>
      db.query(
        "UPDATE billing.usage_charges SET quote=jsonb_set(quote,'{snapshot,payable_credits}','11') WHERE id=$1",
        [id(6)]
      ),
    'immutable'
  );
  await db.query("UPDATE billing.usage_charges SET status='charged' WHERE id=$1", [id(6)]);

  await db.query(
    'UPDATE billing.user_wallets SET main_credits=0,bonus_credits=0 WHERE user_id=$1',
    [uid]
  );
  await db.query("SELECT billing.fail_chat_charge_for_balance($1,'TOTAL_CREDITS_INSUFFICIENT')", [
    id(4),
  ]);
  let failed = await row(
    'SELECT status,charged_credits,settled_at IS NOT NULL AS terminal FROM billing.usage_charges WHERE id=$1',
    [id(4)]
  );
  assert.deepEqual(failed, { status: 'failed', charged_credits: '0.0', terminal: true });
  await db.query('UPDATE billing.user_wallets SET bonus_credits=100 WHERE user_id=$1', [uid]);
  await db.query('SELECT billing.record_chat_turn_charge($1,0,10,now())', [id(4)]);
  failed = await row('SELECT status,charged_credits FROM billing.usage_charges WHERE id=$1', [
    id(4),
  ]);
  assert.deepEqual(
    failed,
    { status: 'failed', charged_credits: '0.0' },
    'later result writes cannot reopen failed bills'
  );
  const replay = await row(
    "SELECT billing.charge_llm_usage($1,NULL,$2,NULL,'a/b','Model',1,1,NULL,1,1,10,false,$3) AS result",
    [
      id(4),
      uid,
      {
        billing_mode: 'fixed_tier',
        fixed_deduction: 10,
        wallet_policy: 'main_then_bonus',
        chat_status: 'success',
        finish_reason: 'stop',
      },
    ]
  );
  assert.equal(replay.result.charge_status, 'already_archived');
  assert.equal(
    Number(replay.result.archived_charge.charged_amount),
    0,
    'funding cannot collect a failed bill'
  );
  await expectError(
    () => db.query("SELECT billing.fail_chat_charge_for_balance($1,'INVALID_AMOUNT')", [id(4)]),
    'Invalid balance'
  );
  await open(7);
  await db.query(
    'UPDATE billing.usage_charges SET reserved_main_credits=0,reserved_bonus_credits=0 WHERE id=$1',
    [id(7)]
  );
  await db.query(
    'UPDATE billing.user_wallets SET main_credits=0,bonus_credits=0 WHERE user_id=$1',
    [uid]
  );
  const args = [
    id(7),
    uid,
    {
      billing_mode: 'fixed_tier',
      payable_credits: 10,
      wallet_policy: 'main_then_bonus',
      chat_status: 'success',
      finish_reason: 'stop',
    },
  ];
  const chargeSql =
    "SELECT billing.charge_llm_usage($1,NULL,$2,NULL,'a/b','Model',1,1,NULL,1,1,10,false,$3) AS result";
  const refused = await row(chargeSql, args);
  assert.deepEqual(refused.result, {
    charge_status: 'insufficient_balance',
    error_code: 'TOTAL_CREDITS_INSUFFICIENT',
  });
  assert.deepEqual(
    await row(
      'SELECT status,charged_credits,settled_at IS NOT NULL AS terminal FROM billing.usage_charges WHERE id=$1',
      [id(7)]
    ),
    { status: 'failed', charged_credits: '0.0', terminal: true },
    'the debit RPC itself commits a permanent failure'
  );
  await db.query('UPDATE billing.user_wallets SET main_credits=100 WHERE user_id=$1', [uid]);
  assert.equal((await row(chargeSql, args)).result.charge_status, 'already_archived');
  assert.equal(
    Number((await row('SELECT count(*) AS n FROM billing.wallet_ledger')).n),
    1,
    'no surprise collection after funding'
  );
  await open(8);
  await expectError(
    () =>
      row(chargeSql, [
        id(8),
        uid,
        {
          billing_mode: 'fixed_tier',
          payable_credits: 10.5,
          wallet_policy: 'main_then_bonus',
          chat_status: 'success',
          finish_reason: 'stop',
        },
      ]),
    'INVALID_AMOUNT'
  );
  assert.equal(
    await held(8),
    10,
    'unknown P0001 rolls back without being hidden as insufficient funds'
  );
  await db.query("UPDATE experience.chat_history SET llm_finish_reason='timeout' WHERE id=$1", [
    id(8),
  ]);
  await db.query(
    'UPDATE billing.user_wallets SET main_credits=0,bonus_credits=0 WHERE user_id=$1',
    [uid]
  );
  await db.query(
    "INSERT INTO billing.usage_charges(id,user_id,kind,status,quote) VALUES($1,$2,'chat_text','pending',$3)",
    [id(9), uid, { charge: { model_markup: 1, metadata: { billing_mode: 'usage' } } }]
  );
  const legacySql = 'SELECT billing.reconcile_llm_usage($1,1,10,$2) AS result';
  assert.equal((await row(legacySql, [id(9), {}])).result.charge_status, 'insufficient_balance');
  await db.query('UPDATE billing.user_wallets SET main_credits=100 WHERE user_id=$1', [uid]);
  assert.equal((await row(legacySql, [id(9), {}])).result.reconcile_status, 'failed');
  assert.equal(
    Number((await row('SELECT count(*) AS n FROM billing.wallet_ledger')).n),
    1,
    'legacy reconciliation cannot collect after failure either'
  );
  await db.query(
    'UPDATE billing.user_wallets SET main_credits=10,bonus_credits=5 WHERE user_id=$1',
    [uid]
  );
  await open(10, 10, 'main_only');
  await debit('other-image-allowed', 5, 'image_generation');
  const paid = await row(chargeSql, [
    id(10),
    uid,
    {
      billing_mode: 'fixed_tier',
      payable_credits: 10,
      wallet_policy: 'main_only',
      chat_status: 'success',
      finish_reason: 'stop',
    },
  ]);
  assert.equal(
    paid.result.charge_status,
    'charged',
    'another allowed consumer does not break the reserved RPC'
  );
  assert.equal(Number(paid.result.charge.charged_amount), 10);
  assert.equal(await held(10), 0);
  await db.query(
    'UPDATE billing.user_wallets SET main_credits=10,bonus_credits=5 WHERE user_id=$1',
    [uid]
  );
  await open(11, 10);
  await open(12, 5, 'main_only');
  for (const [n, amount, policy] of [
    [11, 10, 'main_then_bonus'],
    [12, 5, 'main_only'],
  ]) {
    const result = await row(chargeSql, [
      id(n),
      uid,
      {
        billing_mode: 'fixed_tier',
        payable_credits: amount,
        wallet_policy: policy,
        chat_status: 'success',
        finish_reason: 'stop',
      },
    ]);
    assert.equal(result.result.charge_status, 'charged', 'both accepted reservations can settle');
    assert.equal(Number(result.result.charge.charged_amount), amount);
  }
  assert.deepEqual(
    await row('SELECT main_credits,bonus_credits FROM billing.user_wallets WHERE user_id=$1', [
      uid,
    ]),
    { main_credits: '0.0', bonus_credits: '0.0' }
  );
  await db.exec(
    "INSERT INTO experience.chat_history(id,user_id,status,created_at) SELECT gen_random_uuid(),'11111111-1111-4111-8111-111111111111','success',now()-interval '2 days' FROM generate_series(1,50000); ANALYZE experience.chat_history;"
  );
  const plan = await row(
    "EXPLAIN (FORMAT JSON) SELECT id,created_at,user_id,model,session_id,llm_finish_reason,llm_charge_id,assistant_reply,status FROM experience.chat_history WHERE status='streaming' AND created_at<now()-interval '120 seconds' ORDER BY created_at,id LIMIT 50"
  );
  assert.match(JSON.stringify(plan), /idx_chat_history_streaming_created_id/);
  const acl = await row(
    "SELECT has_function_privilege('authenticated','billing.reserve_chat_charge(uuid)','EXECUTE') AS client"
  );
  assert.deepEqual(acl, { client: false });
  console.log(
    'PASS: admission replay, oversubscription, other-consumer protection, atomic debit/idempotence, free/timeout/failure cleanup, user stop, immutable quote, permanent failure, funding/replay protection, ACL, migration replay/index shape.'
  );
} catch (error) {
  console.error(error.message, error.code ?? '', error.where ?? '');
  if (error.position)
    console.error(
      'At',
      error.position,
      error.query?.slice(Math.max(0, Number(error.position) - 100), Number(error.position) + 60)
    );
  process.exitCode = 1;
} finally {
  await db.close();
}
