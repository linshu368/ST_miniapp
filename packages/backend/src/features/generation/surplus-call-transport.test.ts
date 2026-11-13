import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationLogger, GenerationRequest } from './types.js';

const store = vi.hoisted(() => ({
  prepare: vi.fn(),
  saveObservation: vi.fn(),
  ensureGenerationId: vi.fn(),
}));
vi.mock('../../infrastructure/repositories/SurplusIntelligenceChatHistoryRepository.js', () => ({
  SurplusIntelligenceChatHistoryRepository: class {
    prepare = store.prepare;
    saveObservation = store.saveObservation;
    ensureGenerationId = store.ensureGenerationId;
  },
}));

import { forwardSurplusCall } from './surplus-call-transport.js';

function request(patch: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    userId: 'user-1',
    characterId: 'char-1',
    historyId: 'turn-1',
    sessionId: 'session-1',
    model: {
      modelId: 'surplus-model',
      provider: 'surplus',
      providerModelId: 'm',
      openRouterModelId: 'm',
      tier: 'light',
      isFree: false,
      entitlement: { active: false, validUntil: null },
    },
    messages: [{ role: 'user', content: 'private prompt' }],
    sampling: {},
    userInput: 'private prompt',
    stream: true,
    promptCaching: false,
    ...patch,
  };
}
const logger = { sys: { error: vi.fn() } } as unknown as GenerationLogger;
const body = {
  model: 'm',
  stream: true,
  messages: [{ role: 'user', content: 'private prompt' }],
  stream_options: { include_usage: true },
};
const input = (dispatch: () => Promise<Response>, patch: Partial<GenerationRequest> = {}) => ({
  request: request(patch),
  body,
  signal: new AbortController().signal,
  log: logger,
  dispatch,
});
const terminal = () => store.saveObservation.mock.calls.at(-1)?.[1] as Record<string, unknown>;
async function waitForTerminalObservation(): Promise<void> {
  await vi.waitFor(() =>
    expect(
      store.saveObservation.mock.calls.some((call) =>
        ['completed', 'failed', 'interrupted'].includes(call[1].call_status)
      )
    ).toBe(true)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  store.prepare.mockResolvedValue(undefined);
  store.saveObservation.mockResolvedValue(undefined);
  store.ensureGenerationId.mockResolvedValue(undefined);
});

describe('Surplus call transport', () => {
  it('delivers both source bytes and EOF while ordered diagnostic writes remain pending', async () => {
    let releaseDiagnostic!: () => void;
    const blockedDiagnostic = new Promise<void>((resolve) => {
      releaseDiagnostic = resolve;
    });
    store.saveObservation.mockImplementationOnce(() => blockedDiagnostic);
    const wire =
      'data: {"id":"gen-1","choices":[{"delta":{"content":"reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const response = await forwardSurplusCall(input(async () => new Response(wire)));
    const reader = response.body!.getReader();
    try {
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe(wire);
      expect(first.done).toBe(false);
      expect(store.saveObservation).toHaveBeenCalledOnce();
      expect((await reader.read()).done).toBe(true);
      expect(store.saveObservation).toHaveBeenCalledOnce();
      releaseDiagnostic();
      await waitForTerminalObservation();
      expect(
        store.saveObservation.mock.calls.filter((call) => call[1].call_status === 'completed')
      ).toHaveLength(1);
    } finally {
      releaseDiagnostic();
      reader.releaseLock();
    }
  });

  it('freezes parameters before dispatch and preserves original SSE bytes while capturing sparse facts', async () => {
    const wire = [
      'data: {"id":"gen-1","object":"chat.completion.chunk","system_fingerprint":"fp-one","choices":[{"index":0,"delta":{"role":"assistant","content":"private reply"}}]}',
      'data: {"choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":2,"buyer_cost_micro":"23"}}',
      ': si-secrets-withheld 1',
      'data: [DONE]',
      '',
    ].join('\n\n');
    const dispatch = vi.fn(async () => {
      expect(store.prepare).toHaveBeenCalledOnce();
      return new Response(wire, {
        headers: { 'x-si-request-id': 'request-1', 'x-si-served-by': 'marketplace' },
      });
    });
    const response = await forwardSurplusCall(input(dispatch));
    expect(await response.text()).toBe(wire);
    await waitForTerminalObservation();
    expect(store.prepare.mock.calls[0]?.[0].requestParameters).toEqual({
      model: 'm',
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(store.ensureGenerationId).toHaveBeenCalledExactlyOnceWith('turn-1', 'gen-1');
    expect(terminal()).toMatchObject({
      call_status: 'completed',
      http_status: 200,
      request_id: 'request-1',
      generation_id: 'gen-1',
      prompt_tokens: 0,
      buyer_cost_micro: '23',
      response_metadata: {
        headers: { 'x-si-served-by': 'marketplace' },
        stream: { system_fingerprint: 'fp-one', choices: [{ index: 0, finish_reason: 'stop' }] },
      },
    });
    expect(JSON.stringify(store.saveObservation.mock.calls)).not.toContain('private reply');
    expect(JSON.stringify(store.prepare.mock.calls)).not.toContain('private prompt');
  });

  it('keeps the Surplus loser metadata when the consumer cancels it after another provider wins', async () => {
    const cancelled = vi.fn();
    const wire =
      'data: {"id":"gen-1","model":"m","choices":[{"index":0,"delta":{"content":"private fragment"}}]}\n\n';
    const raw = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(wire));
      },
      cancel: cancelled,
    });
    const response = await forwardSurplusCall(input(async () => new Response(raw)));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel('race_lost');
    await waitForTerminalObservation();
    expect(cancelled).toHaveBeenCalled();
    expect(terminal()).toMatchObject({
      call_status: 'interrupted',
      generation_id: 'gen-1',
      response_metadata: { stream: { id: 'gen-1', model: 'm' } },
    });
    expect(JSON.stringify(terminal())).not.toContain('private fragment');
    expect(
      store.saveObservation.mock.calls.filter((call) => call[1].call_status === 'interrupted')
    ).toHaveLength(1);
  });

  it('captures bounded HTTP error parameters even when the caller would cancel the body', async () => {
    const response = await forwardSurplusCall(
      input(async () =>
        Response.json(
          {
            error: {
              code: 'rate_limit_exceeded',
              type: 'rate_limit_error',
              message: 'private provider body',
            },
          },
          { status: 429, headers: { 'retry-after': '3', 'x-ratelimit-remaining': '0' } }
        )
      )
    );
    expect(response.status).toBe(429);
    expect(response.body).toBeNull();
    await waitForTerminalObservation();
    expect(terminal()).toMatchObject({
      call_status: 'failed',
      http_status: 429,
      response_metadata: {
        headers: { 'retry-after': '3', 'x-ratelimit-remaining': '0' },
        body: { error: { code: 'rate_limit_exceeded', type: 'rate_limit_error' } },
      },
    });
    expect(JSON.stringify(terminal())).not.toContain('private provider body');
  });

  it('does not parse or retain an oversized HTML/error body', async () => {
    await forwardSurplusCall(
      input(async () => new Response('private html'.repeat(7000), { status: 502 }))
    );
    await waitForTerminalObservation();
    expect(terminal()).toMatchObject({ call_status: 'failed', http_status: 502 });
    expect(JSON.stringify(terminal())).not.toContain('private html');
    expect(terminal().response_metadata).toMatchObject({ capture: { status: 'partial' } });
  });

  it('records a network failure without persisting raw transport errors or replaying inference', async () => {
    const dispatch = vi.fn(async () => {
      throw new Error('private network detail');
    });
    await expect(forwardSurplusCall(input(dispatch))).rejects.toThrow('private network detail');
    await waitForTerminalObservation();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(terminal()).toMatchObject({ call_status: 'failed' });
    expect(JSON.stringify(terminal())).not.toContain('private network detail');
  });

  it('captures the non-stream response without changing its payload', async () => {
    const raw = {
      id: 'gen-json',
      model: 'm',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'private reply' },
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 2, buyer_cost_micro: '0' },
    };
    const response = await forwardSurplusCall(
      input(async () => Response.json(raw), { stream: false })
    );
    expect(await response.json()).toEqual(raw);
    await waitForTerminalObservation();
    expect(terminal()).toMatchObject({
      call_status: 'completed',
      generation_id: 'gen-json',
      buyer_cost_micro: '0',
      response_metadata: { body: { model: 'm', usage: { prompt_tokens: 4 } } },
    });
    expect(JSON.stringify(terminal())).not.toContain('private reply');
  });

  it('halts a conflicting provider identity without swallowing the durable CAS failure', async () => {
    store.ensureGenerationId.mockRejectedValueOnce(new Error('identity conflict'));
    const wire = 'data: {"id":"gen-other","choices":[{"delta":{"content":"reply"}}]}\n\n';
    const response = await forwardSurplusCall(input(async () => new Response(wire)));
    await expect(response.text()).rejects.toThrow('identity conflict');
    await waitForTerminalObservation();
    expect(terminal()).toMatchObject({ call_status: 'interrupted' });
    expect(terminal()).not.toHaveProperty('generation_id');
  });

  it('preserves the frozen identity and conflict evidence while omitting a conflicting terminal scalar', async () => {
    let frozenId: string | null = null;
    store.ensureGenerationId.mockImplementation(async (_historyId: string, id: string) => {
      if (frozenId && id !== frozenId) throw new Error('identity conflict');
      frozenId = id;
    });
    store.saveObservation.mockImplementation(
      async (_historyId: string, patch: Record<string, unknown>) => {
        if (patch.generation_id && frozenId && patch.generation_id !== frozenId)
          throw new Error('diagnostic attempted to replace identity');
      }
    );
    const wire = [
      'data: {"id":"gen-frozen","choices":[{"index":0,"delta":{"content":"first"}}]}',
      'data: {"id":"gen-conflicting","choices":[{"index":0,"delta":{"content":"second"}}]}',
      '',
    ].join('\n\n');
    const response = await forwardSurplusCall(input(async () => new Response(wire)));
    const reader = response.body!.getReader();
    await expect(reader.read()).rejects.toThrow('identity conflict');
    reader.releaseLock();
    await waitForTerminalObservation();
    expect(frozenId).toBe('gen-frozen');
    expect(terminal().generation_id).not.toBe('gen-conflicting');
    expect(terminal()).toMatchObject({
      call_status: 'interrupted',
      response_metadata: {
        stream: { id: 'gen-frozen' },
        capture: {
          identity_conflict: true,
          conflicts: expect.arrayContaining([
            { path: 'stream.id', previous: 'gen-frozen', value: 'gen-conflicting' },
          ]),
        },
      },
    });
    expect(
      store.saveObservation.mock.calls.filter((call) => call[1].call_status === 'interrupted')
    ).toHaveLength(1);
  });

  it('does not leave a terminal call without a request-log locator pending forever', async () => {
    const wire =
      'data: {"choices":[{"delta":{"content":"reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const response = await forwardSurplusCall(input(async () => new Response(wire)));
    expect(await response.text()).toBe(wire);
    await waitForTerminalObservation();
    expect(terminal()).toMatchObject({
      request_record_status: 'unavailable',
      response_metadata: {
        capture: {
          unavailable_sources: expect.arrayContaining([
            { source: 'request_record', reason: 'missing_id' },
          ]),
        },
      },
    });
  });

  it('rejects credential-shaped stream IDs before exposing their frame and never persists the raw ID', async () => {
    const invalidId = 'inf_sensitive_fixture_value';
    const wire = `data: ${JSON.stringify({ id: invalidId, choices: [{ delta: { content: 'reply' } }] })}\n\n`;
    const response = await forwardSurplusCall(input(async () => new Response(wire)));
    const reader = response.body!.getReader();
    await expect(reader.read()).rejects.toThrow('identity conflict');
    reader.releaseLock();
    await waitForTerminalObservation();
    expect(store.ensureGenerationId).not.toHaveBeenCalled();
    expect(JSON.stringify(store.saveObservation.mock.calls)).not.toContain(invalidId);
    expect(JSON.stringify((logger.sys.error as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      invalidId
    );
    expect(terminal()).toMatchObject({
      call_status: 'interrupted',
      response_metadata: {
        capture: { identity_conflict: true },
      },
    });
  });

  it('does not send inference if request persistence is unconfirmed', async () => {
    store.prepare.mockRejectedValueOnce(new Error('database unavailable'));
    const dispatch = vi.fn();
    await expect(forwardSurplusCall(input(dispatch))).rejects.toThrow('database unavailable');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('bypasses chat evidence for an auxiliary invocation that has no conversation parent', async () => {
    const dispatch = vi.fn(async () => Response.json({ id: 'auxiliary' }));
    const response = await forwardSurplusCall(input(dispatch, { historyId: null }));
    expect(await response.json()).toEqual({ id: 'auxiliary' });
    expect(store.prepare).not.toHaveBeenCalled();
  });
});

describe('Surplus call transport with parallel primaries', () => {
  const stream = (id: string) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ id, choices: [{ delta: { content: '你好' } }] })}\n\ndata: [DONE]\n\n`
            )
          );
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream', 'x-generation-id': id } }
    );
  const gated = (owns: Promise<boolean>) => ({
    ...input(async () => stream('gen-a')),
    gate: { owns: () => owns },
  });

  it('streams without waiting for the race and drops every write when this call loses', async () => {
    let decide!: (owns: boolean) => void;
    const owns = new Promise<boolean>((resolve) => {
      decide = resolve;
    });
    const response = await forwardSurplusCall(gated(owns));
    expect(await response.text()).toContain('你好');
    expect(store.prepare).toHaveBeenCalledTimes(1);
    expect(store.saveObservation).not.toHaveBeenCalled();
    expect(store.ensureGenerationId).not.toHaveBeenCalled();
    decide(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.saveObservation).not.toHaveBeenCalled();
    expect(store.ensureGenerationId).not.toHaveBeenCalled();
  });

  it('replays the queued writes in order once this call wins', async () => {
    let decide!: (owns: boolean) => void;
    const owns = new Promise<boolean>((resolve) => {
      decide = resolve;
    });
    const response = await forwardSurplusCall(gated(owns));
    await response.text();
    decide(true);
    await waitForTerminalObservation();
    expect(store.ensureGenerationId).toHaveBeenCalledWith('turn-1', 'gen-a');
    const statuses = store.saveObservation.mock.calls.map((call) => call[1].call_status);
    expect(statuses[0]).toBe('dispatched');
    expect(statuses.at(-1)).toBe('completed');
  });
});
