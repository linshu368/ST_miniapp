import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AlertEvaluationSchema,
  DEFAULT_LLM_RELAY_PROVIDER_CONFIG,
  LlmRelayProviderConfigSchema,
  type ProviderBalance,
} from '@miniapp/shared';
import type { GenerationRequest } from './types.js';

vi.mock('../../platform/runtime-config.js', () => ({
  getLlmProviderRuntimeConfig: () => ({
    baseUrl: 'https://relay.test/v1',
    apiKey: 'synthetic-inference',
  }),
  getRelayManagementConfig: () => ({
    baseUrl: 'https://relay.test',
    apiKey: 'synthetic-management',
    userId: '42',
  }),
  getRelayProxyUrl: () => '',
  fetchRuntimeConfigEntryStrict: vi.fn(async () => null),
}));
vi.mock('./relay-call-ledger.js', () => ({
  writeRelayCall: vi.fn(async () => undefined),
  relayAccountRef: () => 'synthetic-account',
}));
vi.mock('../../platform/relay-provider-balance.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform/relay-provider-balance.js')>()),
  getRelayBalance: vi.fn(),
}));
import { readRelayJson, relayGet } from '../../infrastructure/relay-provider-client.js';
import { normalizeRelayBaseUrl } from '../../platform/relay-provider-urls.js';
import {
  mapRelayModels,
  RelayProviderDirectoryClient,
} from '../../platform/relay-provider-directory.js';
import { parseRelayBalance, getRelayBalance } from '../../platform/relay-provider-balance.js';
import { relayConversion } from '../../platform/relay-provider-policy.js';
import { fetchRuntimeConfigEntryStrict } from '../../platform/runtime-config.js';
import { relayUsageSnapshot } from './relay-usage.js';
import { forwardRelayCall } from './relay-call-transport.js';
import { writeRelayCall } from './relay-call-ledger.js';
import { RelayBalanceMonitor } from './relay-balance-alerts.js';
import { lookupRelayInvoice } from './relay-invoices.js';
import { buildUpstreamBody } from './generation-body.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('generation');
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('relay safety boundaries', () => {
  it('normalizes v1 exactly once and rejects credential-bearing endpoints', () => {
    expect(normalizeRelayBaseUrl('https://relay.test/v1/', 'inference')).toBe(
      'https://relay.test/v1'
    );
    expect(normalizeRelayBaseUrl('https://relay.test/api', 'management')).toBe(
      'https://relay.test'
    );
    for (const value of [
      'http://relay.test',
      'https://user:secret@relay.test',
      'https://relay.test/?key=synthetic',
      'https://relay.test/v1/v1',
    ])
      expect(() => normalizeRelayBaseUrl(value, 'inference')).toThrow();
  });
  it('retains unknown counters, legitimate zero and subset token counts', () => {
    expect(relayUsageSnapshot(null).usage.prompt_tokens).toBeNull();
    const usage = relayUsageSnapshot({
      prompt_tokens: 0,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 3 },
      content: 'must never persist',
    });
    expect(usage.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 10,
      cached_tokens: 0,
      reasoning_tokens: 3,
    });
    expect(JSON.stringify(usage)).not.toContain('must never persist');
  });
  it('requires explicit unit provenance and keeps unknown USD separate from zero', () => {
    expect(relayConversion(DEFAULT_LLM_RELAY_PROVIDER_CONFIG.packy).usdPerQuota).toBeNull();
    expect(
      LlmRelayProviderConfigSchema.safeParse({ packy: { usd_per_cny: 1 }, onexmodel: {} }).success
    ).toBe(false);
    expect(
      LlmRelayProviderConfigSchema.safeParse({ packy: { monitor_enabled: true }, onexmodel: {} })
        .success
    ).toBe(false);
    expect(parseRelayBalance({ success: true, data: { quota: 0 } })).toBe(0);
    for (const body of [
      { success: false, data: { quota: 0 } },
      { success: true, data: {} },
      { success: true, data: { quota: -1 } },
    ])
      expect(() => parseRelayBalance(body)).toThrow();
  });
  it('rejects HTML/oversized responses and does not retry authentication failures', async () => {
    await expect(readRelayJson(new Response('<html>blocked</html>'))).rejects.toThrow(
      'invalid_body'
    );
    await expect(readRelayJson(new Response('x'.repeat(20)), 10)).rejects.toThrow('invalid_body');
    const fetchImpl = vi.fn(async () => new Response('blocked', { status: 403 }));
    await expect(
      relayGet({
        provider: 'packy',
        url: 'https://relay.test',
        headers: {},
        operation: 'provider.models',
        fetchImpl,
      })
    ).rejects.toThrow('auth_failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const limited = vi.fn(
      async () => new Response('limited', { status: 429, headers: { 'Retry-After': '999999' } })
    );
    await expect(
      relayGet({
        provider: 'packy',
        url: 'https://relay.test',
        headers: {},
        operation: 'provider.models',
        fetchImpl: limited,
      })
    ).rejects.toMatchObject({ code: 'rate_limited', retryAfterMs: 3_600_000 });
    expect(limited).toHaveBeenCalledTimes(1);
  });
});

describe('exact relay invoice attribution', () => {
  const row = {
    id: 123,
    request_id: 'synthetic-request',
    type: 2,
    user_id: 42,
    token_id: 7,
    model_name: 'chat',
    group: 'synthetic-group',
    quota: 0,
    prompt_tokens: 0,
    completion_tokens: 1,
  };
  const input = {
    provider: 'packy' as const,
    requestId: 'synthetic-request',
    model: 'chat',
    accountRef: 'synthetic-account',
    dispatchedAt: new Date(),
  };
  function mockInvoices(items: unknown[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        const path = new URL(String(url)).pathname;
        if (path === '/api/usage/token/')
          return Response.json({ data: { name: 'synthetic-name' } });
        if (path === '/api/token/')
          return Response.json({
            success: true,
            data: {
              items: [
                {
                  id: 7,
                  user_id: 42,
                  name: 'synthetic-name',
                  key: 'synthetic-inference',
                  group: 'synthetic-group',
                },
              ],
              total: 1,
            },
          });
        return Response.json({ success: true, data: { items, total: items.length } });
      })
    );
  }
  it('uses account, Key, request ID and model; legitimate zero is an actual native invoice', async () => {
    mockInvoices([row, { ...row, id: 999, request_id: 'unrelated-request' }]);
    expect(await lookupRelayInvoice(input)).toMatchObject({
      status: 'matched',
      invoice: { logId: '123', quota: 0, promptTokens: 0 },
    });
  });
  it('never matches a nearby request or a different account/model', async () => {
    mockInvoices([{ ...row, request_id: 'nearby-request' }]);
    expect(await lookupRelayInvoice(input)).toEqual({ status: 'pending' });
    mockInvoices([{ ...row, model_name: 'other-model' }]);
    expect(await lookupRelayInvoice(input)).toEqual({ status: 'conflict' });
    expect(await lookupRelayInvoice({ ...input, accountRef: 'different-account' })).toEqual({
      status: 'unavailable',
    });
  });
  it('rejects ambiguous invoices, contradictory duplicates and refunds', async () => {
    mockInvoices([row, { ...row, id: 124 }]);
    expect(await lookupRelayInvoice(input)).toEqual({ status: 'ambiguous' });
    mockInvoices([row, { ...row, quota: 5 }]);
    expect(await lookupRelayInvoice(input)).toEqual({ status: 'conflict' });
    mockInvoices([{ ...row, type: 3 }]);
    expect(await lookupRelayInvoice(input)).toEqual({ status: 'conflict' });
  });
});

describe('relay directory ownership', () => {
  it('requires both key authorization and positive chat capability, with unknown prices', () => {
    const models = mapRelayModels(
      'onexmodel',
      {
        data: [
          { id: 'allowed', supported_endpoint_types: ['openai'] },
          { id: 'image', supported_endpoint_types: ['image'] },
          { id: 'unknown' },
        ],
      },
      { data: [{ model_name: 'public-only', supported_endpoint_types: ['openai'] }] }
    );
    expect(models.map((model) => model.id)).toEqual(['allowed']);
    expect(models[0]?.prompt_usd_per_token).toBeNull();
    expect(
      mapRelayModels(
        'packy',
        { data: [] },
        { data: [{ model_name: 'public-only', supported_endpoint_types: ['openai'] }] }
      )
    ).toEqual([]);
  });
  it('coalesces refreshes, retains a stale directory and never uses management auth for inference', async () => {
    let failed = false;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (failed) throw new Error('synthetic-network-failure');
      return Response.json(
        String(url).endsWith('/models')
          ? { data: [{ id: 'chat', supported_endpoint_types: ['openai'] }] }
          : { data: [] }
      );
    });
    const client = new RelayProviderDirectoryClient('packy', { fetchImpl });
    const [first, second] = await Promise.all([client.getModels(), client.getModels()]);
    expect(first).toBe(second);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.headers).not.toHaveProperty('New-API-User');
    failed = true;
    expect((await client.getModels({ forceRefresh: true })).stale).toBe(true);
  });
});

describe('relay terminal observation', () => {
  const request = (): GenerationRequest => ({
    userId: 'synthetic-user',
    historyId: '00000000-0000-4000-8000-000000000010',
    characterId: null,
    model: {
      modelId: 'stable-model',
      provider: 'packy',
      providerModelId: 'chat',
      openRouterModelId: 'chat',
      tier: 'light',
      entitlement: { active: false, validUntil: null },
    },
    messages: [],
    sampling: {},
    userInput: 'synthetic',
    stream: true,
    promptCaching: false,
  });
  it('preserves SSE bytes, captures final usage and never persists content', async () => {
    const body =
      'data: {"id":"synthetic-generation","choices":[{"delta":{"content":"private reply"}}]}\n\n' +
      'data: {"usage":{"prompt_tokens":0,"completion_tokens":3},"choices":[]}\n\ndata: [DONE]\n\n';
    const response = await forwardRelayCall({
      request: request(),
      signal: new AbortController().signal,
      log,
      dispatch: async () =>
        new Response(body, { headers: { 'x-request-id': 'synthetic-request' } }),
    });
    expect(await response.text()).toBe(body);
    await vi.waitFor(() => expect(writeRelayCall).toHaveBeenCalledTimes(2));
    const terminal = vi.mocked(writeRelayCall).mock.calls[1]?.[0];
    expect(terminal).toMatchObject({
      status: 'succeeded',
      requestId: 'synthetic-request',
      usage: { prompt_tokens: 0, completion_tokens: 3 },
    });
    expect(JSON.stringify(terminal)).not.toContain('private reply');
  });
  it('records an upstream rejection without repeating the POST', async () => {
    const dispatch = vi.fn(async () => new Response('denied', { status: 401 }));
    const response = await forwardRelayCall({
      request: request(),
      signal: new AbortController().signal,
      log,
      dispatch,
    });
    expect(response.status).toBe(401);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(writeRelayCall).toHaveBeenCalledTimes(2));
    expect(vi.mocked(writeRelayCall).mock.calls[1]?.[0]).toMatchObject({
      status: 'failed',
      httpStatus: 401,
    });
  });
  it('requests streaming usage without vendor-specific routing or caching fields', () => {
    for (const provider of ['packy', 'onexmodel'] as const) {
      const input = request();
      input.model.provider = provider;
      const body = buildUpstreamBody(input, { order: ['synthetic-route'] });
      expect(body.stream_options).toEqual({ include_usage: true });
      expect(body).not.toHaveProperty('provider');
      expect(body).not.toHaveProperty('venice_parameters');
      expect(body).not.toHaveProperty('prompt_cache_key');
    }
  });
});

it('requires consecutive healthy balance samples, with failures resetting recovery', async () => {
  vi.mocked(fetchRuntimeConfigEntryStrict).mockResolvedValue({
    value: { packy: { monitor_enabled: true, low_balance_quota: 10 }, onexmodel: {} },
    textValue: null,
    version: 1,
  });
  const healthy: ProviderBalance = {
    provider: 'packy',
    status: 'ok',
    fetched_at: new Date().toISOString(),
    native_balance: 20,
    native_unit: 'quota',
    balance_cny: null,
    balance_usd: null,
    conversion_version: null,
    error_code: null,
  };
  vi.mocked(getRelayBalance)
    .mockResolvedValueOnce(healthy)
    .mockResolvedValueOnce({
      ...healthy,
      status: 'failed',
      native_balance: null,
      error_code: 'timeout',
    })
    .mockResolvedValue(healthy);
  const publish = vi.fn(async (_input: unknown) => ({ kind: 'accepted' as const }));
  const monitor = new RelayBalanceMonitor('packy', { publish }, log);
  await monitor.runOnce();
  await monitor.runOnce();
  await monitor.runOnce();
  expect(publish).not.toHaveBeenCalled();
  await monitor.runOnce();
  expect(publish).toHaveBeenCalledTimes(1);
  expect(AlertEvaluationSchema.safeParse(publish.mock.calls[0]?.[0]).success).toBe(true);
});
