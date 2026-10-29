import { createHmac, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { GenerationObservationRepository } from './GenerationObservationRepository.js';
import type { LlmBillingSnapshot } from './ConversationHistoryRepository.js';
import type { ReportFirstTokenRequest } from '@miniapp/shared';

// Deliberately opt-in, synthetic, and loopback-only. Never uses application DB credentials.
const url = process.env.FIRST_TOKEN_TEST_REST_URL;
const secret = 'first-token-local-fixture-only-jwt-secret-at-least-32-characters';
function token(role: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 600 })
  ).toString('base64url');
  return `${header}.${body}.${createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')}`;
}
const h = randomUUID(),
  requestId = randomUUID(),
  primaryId = randomUUID(),
  fallbackId = randomUUID(),
  chargeId = randomUUID();
const owner = '00000000-0000-0000-0000-000000000099',
  session = '00000000-0000-0000-0000-000000000090';
const quote: LlmBillingSnapshot = {
  charge_id: chargeId,
  model_id: 'rpc-selected',
  model_display_name: 'Selected Premium',
  provider: 'venice',
  provider_model_id: 'selected-source',
  model_markup: 0,
  fixed_deduction: 30,
  fixed_deduction_category: 'premium',
  catalog_version: 1,
  pricing_config_version: 7,
  exchange_rate: 1,
  billing_mode: 'fixed_tier',
  original_credits: 30,
  payable_credits: 30,
  wallet_policy: 'main_only',
  requires_vip: true,
  vip_active: true,
  vip_discount_config_version: 9,
};
const firstReport: ReportFirstTokenRequest = {
  request_id: requestId,
  assistant_message_id: h,
  revision: 0,
  measurement_method: 'visible_dom_after_frame_v1',
  outcome: 'observed',
  first_token_visible_ms: 5300,
  first_token_received_ms: 5100,
  request_dispatched_ms: 10,
  backgrounded: false,
  reason: null,
};

describe.skipIf(!url)('real local PostgREST generation facts', () => {
  if (url && !/^http:\/\/127\.0\.0\.1:\d+$/.test(url))
    throw new Error('FIRST_TOKEN_TEST_REST_URL must be an isolated loopback URL');
  const endpoint = url ?? 'http://127.0.0.1:1';
  const options = {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const target = new URL(input instanceof Request ? input.url : String(input));
        if (target.origin !== endpoint) throw new Error('Fixture fetch left loopback endpoint');
        // Supabase's gateway prefix is absent on standalone PostgREST.
        target.pathname = target.pathname.replace(/^\/rest\/v1/, '');
        return fetch(target, init);
      },
    },
  };
  const client = createClient(endpoint, token('service_role'), options);
  const db = client.schema('experience');
  const repository = new GenerationObservationRepository(db);
  const begin = {
    historyId: h,
    requestId,
    primaryAttemptId: primaryId,
    requestedModelId: 'rpc-selected',
    provider: 'venice' as const,
    model: 'selected-source',
    receivedAt: '2026-10-22T03:00:00Z',
    timeoutMs: 4000,
    deadlineMs: 6000,
    timeoutRateTarget: 0.01,
    catalogVersion: 1,
    mode: 'regenerate' as const,
  };
  beforeAll(async () => {
    const { error } = await db.from('chat_history').insert({
      id: h,
      user_id: owner,
      session_id: session,
      model: 'selected-source',
      revision: 0,
    });
    if (error) throw error;
  });
  it('durably prepares a request before quoting, then binds exactly one frozen quote', async () => {
    await repository.begin(begin);
    const initial = await db
      .from('chat_history')
      .select('llm_billing_snapshot')
      .eq('id', h)
      .single();
    expect(initial.error).toBeNull();
    expect(initial.data?.llm_billing_snapshot).toBeNull();
    const charge = await db.from('chat_history').update({ llm_charge_id: chargeId }).eq('id', h);
    if (charge.error) throw charge.error;
    await repository.begin({ ...begin, snapshot: quote });
    await repository.prepareFallback(
      h,
      {
        id: fallbackId,
        role: 'fallback',
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4.1-flash',
      },
      4200
    );
    await repository.observe(h, {
      id: fallbackId,
      role: 'fallback',
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4.1-flash',
      generation_id: `fallback-${h}`,
      dispatch_offset_ms: 4250,
      first_token_ms: 800,
      end_reason: 'first_token_observed',
    });
  });
  it('atomically selects only fallback metadata and keeps late primary data separate', async () => {
    await repository.selectDelivery(h, {
      id: fallbackId,
      role: 'fallback',
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4.1-flash',
      generation_id: `fallback-${h}`,
    });
    await repository.observe(h, {
      id: primaryId,
      role: 'primary',
      provider: 'venice',
      model: 'selected-source',
      generation_id: `observer-${h}`,
      first_token_ms: 8000,
      end_reason: 'first_token_observed',
    });
    const row = await db.from('chat_history').select('llm_billing_snapshot').eq('id', h).single();
    if (row.error) throw row.error;
    expect(row.data.llm_billing_snapshot).toEqual({
      ...quote,
      provider: 'openrouter',
      provider_model_id: 'deepseek/deepseek-v4.1-flash',
    });
    const provider = await db
      .from('openrouter_chat_history')
      .select('llm_generation_id')
      .eq('chat_history_id', h)
      .single();
    expect(provider.data?.llm_generation_id).toBe(`fallback-${h}`);
    const observer = await db.from('venice_chat_history').select('id').eq('chat_history_id', h);
    expect(observer.data).toEqual([]);
    await repository.enrichGeneration(`fallback-${h}`, {
      latency: 700,
      provider_name: 'Fixture Vendor',
      finish_reason: 'stop',
      model: 'fixture-delivered-model',
    });
  });
  it('enforces owner/revision, accepts first report once, and returns consistent analytics', async () => {
    expect(await repository.report(randomUUID(), session, firstReport)).toBe(false);
    expect(await repository.report(owner, session, { ...firstReport, revision: 1 })).toBe(false);
    expect(await repository.report(owner, session, firstReport)).toBe(true);
    expect(
      await repository.report(owner, session, {
        ...firstReport,
        outcome: 'timed_out',
        first_token_visible_ms: null,
      })
    ).toBe(true);
    const rows = await client.schema('miniapp_analytics').rpc('chat_first_token_report', {
      p_from: '2026-10-22T00:00:00+08',
      p_to: '2026-10-23T00:00:00+08',
    });
    if (rows.error) throw rows.error;
    const report = (rows.data as Array<Record<string, unknown>>).find(
      (r) => r.model_id === 'rpc-selected'
    );
    expect(report).toMatchObject({
      requests: 1,
      model_requests: 1,
      sample_eligible: false,
      user_first_token_p90_ms: 5300,
      fallback_selected: 1,
      client_timeouts: 0,
      fallback_provider_gap_p90_ms: 100,
    });
  });
  it('allows dedicated metrics reads but denies message content and client direct reporting', async () => {
    const metrics = createClient(endpoint, token('first_token_metrics_reader'), options);
    const view = await metrics
      .schema('miniapp_analytics')
      .from('chat_first_token_facts')
      .select(
        'chat_history_id,first_token_emitted_ms,client_request_dispatched_ms,client_wait_finished_ms'
      )
      .eq('chat_history_id', h);
    expect(view.error).toBeNull();
    expect(view.data).toHaveLength(1);
    expect(view.data![0]).toMatchObject({
      first_token_emitted_ms: null,
      client_request_dispatched_ms: null,
      client_wait_finished_ms: null,
    });
    const content = await metrics
      .schema('experience')
      .from('chat_history')
      .select('user_input')
      .eq('id', h);
    expect(content.error?.code).toBe('42501');
    const anonymous = createClient(endpoint, token('anon'), options);
    const denied = await anonymous.schema('experience').rpc('report_chat_first_token', {
      p_user_id: owner,
      p_session_id: session,
      p_report: firstReport,
    });
    expect(denied.error).not.toBeNull();
  });

  it('returns terminal HTTP 409 for permanent delivery conflicts instead of retrying transactions', async () => {
    const primary = await db
      .rpc('select_chat_generation_delivery', {
        p_history_id: h,
        p_attempt_id: primaryId,
        p_generation_id: `observer-${h}`,
      })
      .abortSignal(AbortSignal.timeout(1500));
    expect(primary.status).toBe(409);
    expect(primary.error?.code).toBe('PT409');
    const ended = await db.from('chat_history').update({ status: 'success' }).eq('id', h);
    expect(ended.error).toBeNull();
    const stale = await db
      .rpc('begin_chat_generation_observation', { p_history_id: h, p_input: {} })
      .abortSignal(AbortSignal.timeout(1500));
    expect(stale.status).toBe(409);
    expect(stale.error?.code).toBe('PT409');
    const fallback = await db
      .rpc('prepare_chat_generation_fallback', {
        p_history_id: h,
        p_attempt_id: randomUUID(),
        p_triggered_ms: 4000,
      })
      .abortSignal(AbortSignal.timeout(1500));
    expect(fallback.status).toBe(409);
    expect(fallback.error?.code).toBe('PT409');
    const unchanged = await db
      .from('chat_generation_requests')
      .select('delivery_attempt_id')
      .eq('chat_history_id', h)
      .single();
    expect(unchanged.data?.delivery_attempt_id).toBe(fallbackId);
  });
});
