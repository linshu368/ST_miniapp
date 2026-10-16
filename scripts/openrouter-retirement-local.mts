// Isolated PG/PostgREST only. Run through test-openrouter-retirement-local.sh.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ConversationHistoryRepository } from '../packages/backend/src/infrastructure/repositories/ConversationHistoryRepository.js';
import { OpenRouterChatHistoryRepository } from '../packages/backend/src/infrastructure/repositories/OpenRouterChatHistoryRepository.js';
import { VeniceChatHistoryRepository } from '../packages/backend/src/infrastructure/repositories/VeniceChatHistoryRepository.js';
const requireBackend = createRequire(new URL('../packages/backend/package.json', import.meta.url));
const { createClient } = requireBackend(
  '@supabase/supabase-js'
) as typeof import('../packages/backend/node_modules/@supabase/supabase-js');
const url = process.env.OPENROUTER_RETIREMENT_LOCAL_URL;
assert(url && new URL(url).hostname === '127.0.0.1', 'local loopback target required');
const client = createClient(url, 'synthetic-local-fixture', {
  auth: { persistSession: false, autoRefreshToken: false },
  global: {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete('authorization');
      headers.delete('apikey');
      const target = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      );
      target.pathname = target.pathname.replace(/^\/rest\/v1/, '') || '/';
      return fetch(target, { ...init, headers, signal: AbortSignal.timeout(5_000) });
    },
  },
});
const db = client.schema('experience');
const histories = new ConversationHistoryRepository(db);
const or = new OpenRouterChatHistoryRepository(db);
const venice = new VeniceChatHistoryRepository(db);
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const check = (result: { error: unknown }) => assert.equal(result.error, null);
const absent = await db.from('chat_history').select('llm_generation_id');
assert(absent.error, 'physical legacy column must be gone');
const absentAlias = await db.from('openrouter_chat_history').select('llm_usage');
assert(absentAlias.error, 'physical provider alias must be gone');

for (const [n, provider] of [
  [10, 'openrouter'],
  [11, 'venice'],
] as const) {
  check(await db.from('chat_history').insert({ id: id(n), turn_index: 10, revision: n - 9 }));
  await histories.setPromptHistory(id(n), [
    { role: 'assistant', content: 'opening' },
    { role: 'user', content: 'original input' },
  ]);
  await histories.registerChargeId(id(n), id(100 + n));
  await histories.saveBillingSnapshot(id(n), {
    charge_id: id(100 + n),
    model_id: null,
    provider,
    model_display_name: 'fixture',
    model_markup: 1,
    fixed_deduction: 5,
    fixed_deduction_category: 'light',
    catalog_version: 1,
    pricing_config_version: 1,
    exchange_rate: 1,
    billing_mode: 'fixed_tier',
  });
  const detail = provider === 'openrouter' ? or : venice;
  await detail.ensurePlaceholder(id(n));
  await Promise.all([
    detail.ensureGenerationId(id(n), `fixture-${n}`),
    detail.ensureGenerationId(id(n), `fixture-${n}`),
  ]);
  await assert.rejects(detail.ensureGenerationId(id(n), `different-${n}`), /冲突/);
  const row = await histories.finalizeTurn({
    historyId: id(n),
    content: '完整回复',
    status: 'success',
    finishReason: 'stop',
  });
  assert.equal(row.assistant_reply, '完整回复');
  assert.equal(row.user_input, 'original input');
  assert.equal(row.llm_finish_reason, 'stop');
}
const pending = await histories.listRowsPendingBilling({
  since: '2020-01-01T00:00:00Z',
  limit: 50,
  provider: 'openrouter',
});
assert.equal(pending.find((row) => row.id === id(10))?.generationId, 'fixture-10');
const pendingVenice = await histories.listRowsPendingBilling({
  since: '2020-01-01T00:00:00Z',
  limit: 50,
  provider: 'venice',
});
assert.equal(pendingVenice.find((row) => row.id === id(11))?.generationId, 'fixture-11');
assert.equal(pendingVenice.find((row) => row.id === id(11))?.callProvider, 'venice');
// Still-pending metadata is a valid durable call, not a failed conversation.
assert.equal((await or.readGenerationData(id(10)))?.usage, null);
assert(
  (await or.listRowsMissingGenerationData({ since: '2020-01-01T00:00:00Z', limit: 50 })).some(
    (row) => row.id === id(10) && row.generationId === 'fixture-10'
  )
);
await or.upsert({
  chat_history_id: id(10),
  llm_generation_id: 'fixture-10',
  usage: 0,
  usage_cache: 0,
  latency: 0,
  generation_time: 2,
  finish_reason: 'stop',
});
assert.equal((await or.readGenerationData(id(10)))?.usage, 0);
// A null/late response must never erase a durable identity.
await or.upsert({ chat_history_id: id(10), llm_generation_id: null, model: 'fixture/model' });
assert.equal(
  (
    await histories.listRowsPendingBilling({
      since: '2020-01-01T00:00:00Z',
      limit: 50,
      provider: 'openrouter',
    })
  ).find((row) => row.id === id(10))?.generationId,
  'fixture-10'
);
await histories.recordBillingOutcome({
  historyId: id(10),
  deductionRate: 5,
  intendedDeduction: 5,
  billingSettledAt: new Date().toISOString(),
});
assert(
  !(
    await histories.listRowsPendingBilling({
      since: '2020-01-01T00:00:00Z',
      limit: 50,
      provider: 'openrouter',
    })
  ).some((row) => row.id === id(10))
);
const context = await histories.getContextBeforeTurn(id(90), 11);
assert(context.messages.some((row) => row.content === '完整回复'));
const messages = await histories.listMessages(id(90), 'opening');
assert.equal(
  messages.messages.filter((row) => row.turn_index === 10 && row.role === 'assistant').length,
  1
);
assert.equal(
  messages.messages.find((row) => row.turn_index === 10 && row.role === 'assistant')?.revision,
  2
);

check(
  await db
    .from('chat_history')
    .insert({ id: id(12), turn_index: 12, llm_finish_reason: 'cancelled' })
);
await histories.finalizeTurn({
  historyId: id(12),
  content: '已收到的部分回复',
  status: 'stream_interrupted',
  finishReason: 'stop',
});
await histories.recordBillingOutcome({ historyId: id(12), finishReason: 'stop' });
const cancelled = await histories.requireTurnById(id(12));
assert.equal(cancelled.llm_finish_reason, 'cancelled');
assert.equal(cancelled.assistant_reply, '已收到的部分回复');

check(
  await db.from('chat_history').insert({
    id: id(13),
    turn_index: 13,
    status: 'upstream_error',
    created_at: '2020-01-02T00:00:00Z',
    llm_billing_snapshot: { provider: 'openrouter' },
    llm_charge_id: id(113),
  })
);
await or.ensurePlaceholder(id(13));
const missing = await histories.listRowsMissingProviderIdentity({
  since: '2020-01-01T00:00:00Z',
  limit: 50,
});
assert(missing.some((row) => row.id === id(13) && row.generationId === null));
assert(
  !missing.some((row) => row.id === id(11)),
  'Venice identity must not enter missing-identity recovery'
);
console.log(
  'Real repositories passed: prompt/body/finalize, provider ID CAS/concurrency, pending/missing scans, billing outcome, cancel/late stop, context/latest revision and pending metadata after both physical DROP operations.'
);
await client.removeAllChannels();
