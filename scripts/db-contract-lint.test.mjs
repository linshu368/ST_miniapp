import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lintSql, loadRegistry } from './db-contract-lint.mjs';

const registry = {
  schemas: { ops: {}, billing: {}, experience: {}, app_core: {} },
  tables: {
    'experience.chat_history': { nature: 'E', status: 'moving' },
    'experience.chat_generation_attempts': { nature: 'S', status: 'moving' },
    'experience.chat_generation_requests': { nature: 'S', status: 'moving', billing_input: true },
    'experience.chat_sessions': { nature: 'E', status: 'active' },
    'experience.chat_image_jobs': { nature: 'J', status: 'planned' },
    'ops.llm_calls': { nature: 'O', status: 'planned' },
    'ops.alert_deliveries': { nature: 'J', status: 'planned' },
    'app_core.users': { nature: 'E', status: 'moving' },
  },
  inflow: new Map([['experience.chat_generation_attempts', new Set(['candidate_id', 'slot'])]]),
};

const messages = (sql) => lintSql(sql, registry).map((w) => w.message);

test('clean migration produces no warnings', () => {
  const sql = `
    create table if not exists ops.llm_calls (
      attempt_id uuid primary key,
      first_token_ms numeric,
      raw_usage jsonb,
      constraint llm_calls_ms_check check (first_token_ms >= 0)
    );
    create table experience.chat_image_jobs (image_id uuid primary key, lease_owner text, attempts int not null default 0);
    alter table experience.chat_sessions add column archived_at timestamptz;
    alter table experience.chat_generation_attempts add column if not exists candidate_id text, add column slot smallint;
  `;
  assert.deepEqual(messages(sql), []);
});

test('adding columns to moving/frozen tables warns unless planned inflow', () => {
  const out = messages('alter table experience.chat_history add column drive_mode text;');
  assert.equal(out.length, 1);
  assert.match(out[0], /moving/);
});

test('telemetry, money, job and vague columns outside their home warn', () => {
  const out = messages(`
    alter table experience.chat_sessions
      add column render_ms integer,
      add column price_credits numeric,
      add column next_retry_at timestamptz,
      add column metadata jsonb,
      add column debit_ledger_id uuid;
  `);
  assert.equal(out.length, 4);
  assert.ok(out.some((m) => m.includes('render_ms')));
  assert.ok(out.some((m) => m.includes('price_credits')));
  assert.ok(out.some((m) => m.includes('next_retry_at')));
  assert.ok(out.some((m) => m.includes('metadata')));
});

test('billing_input tables may keep delivery timings', () => {
  assert.deepEqual(
    messages(
      'alter table experience.chat_generation_requests add column client_visible_ms numeric;'
    ).filter((m) => m.includes('_ms')),
    []
  );
});

test('unregistered tables, vendor names, nature/schema mismatch, schema and wrapper functions warn', () => {
  const out = messages(`
    create schema if not exists scratch;
    create table experience.venice_usage (id uuid primary key);
    create table ops.alert_deliveries (id bigint primary key);
    create or replace function admin.is_managed_config_key_before_foo(p text) returns boolean language sql as $$ select true $$;
  `);
  assert.ok(out.some((m) => m.includes('scratch')));
  assert.ok(out.some((m) => m.includes('venice_usage') && m.includes('未')));
  assert.ok(out.some((m) => m.includes('供应商')));
  assert.ok(out.some((m) => m.includes('_jobs')));
  assert.ok(out.some((m) => m.includes('_before_')));
});

test('dropping a table still registered as active warns; moving does not', () => {
  assert.equal(messages('drop table if exists experience.chat_sessions;').length, 1);
  assert.equal(messages('drop table if exists app_core.users cascade;').length, 0);
});

test('set schema followed by rename in the same file counts as one move', () => {
  const ok = `
    alter table app_core.old_outbox set schema ops;
    alter table ops.old_outbox rename to alert_deliveries;
  `;
  assert.deepEqual(messages(ok), []);
  const bad = messages('alter table app_core.old_outbox set schema ops;');
  assert.equal(bad.length, 1);
  assert.match(bad[0], /ops\.old_outbox/);
});

test('comments are ignored and line numbers point at the statement', () => {
  const warnings = lintSql(
    '-- alter table experience.chat_history add column x_ms int;\n\nalter table experience.chat_sessions add column y_ms int;',
    registry
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].line, 3);
});

test('migrations written before a rename still resolve through renamed_from', () => {
  const real = loadRegistry();
  assert.equal(real.schemas.miniapp_features, real.schemas.features);
  assert.equal(
    real.tables['miniapp_features.free_zone_models'],
    real.tables['features.free_zone_models']
  );
  assert.equal(
    real.tables['miniapp_features.character_ranking_scores'],
    real.tables['features.lobby_ranking_scores']
  );
  assert.equal(
    real.tables['features.character_ranking_scores'],
    real.tables['features.lobby_ranking_scores']
  );
  const old = lintSql(
    'alter table miniapp_features.free_zone_models add column if not exists pinned boolean;',
    real
  );
  assert.deepEqual(
    old.map((w) => w.message),
    []
  );
});

test('repository registry parses and every move target is registered', () => {
  const real = loadRegistry();
  for (const [table, entry] of Object.entries(real.tables)) {
    for (const move of entry.move ?? []) {
      assert.ok(real.tables[move.to], `${table} → ${move.to} 未登记`);
    }
  }
});
