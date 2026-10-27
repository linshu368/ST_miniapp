import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIRST_TOKEN_FALLBACK_MODEL_ID } from '@miniapp/shared';
import {
  forwardWithFirstTokenFallback,
  type FirstTokenAttemptStore,
  type TransportModel,
} from './first-token-fallback.js';
import type { AttemptObservation } from '../../infrastructure/repositories/GenerationObservationRepository.js';

afterEach(() => vi.useRealTimers());
const token = (id: string, text: string) =>
  `data:${JSON.stringify({ id, choices: [{ delta: { content: text } }] })}\n\n`;

function setup(options: {
  primaryAt: number;
  deferPersistence?: boolean;
  fallbackAt?: number;
  fallbackModelId?: string;
  primary?: TransportModel;
  controls?: boolean;
  selectionDelay?: number;
  thinkingEnabled?: boolean;
  reasoningAt?: number;
  fallbackReasoningAt?: number;
  legacyReasoning?: boolean;
  timeoutMs?: number;
  fallbackTimeoutMs?: number;
  totalMs?: number;
  routeDelay?: number;
  fallbackPrepareDelay?: number;
  headersDelay?: number;
}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const calls: Array<{ model: TransportModel; cancelled: boolean }> = [];
  const observations: AttemptObservation[] = [];
  const store: FirstTokenAttemptStore = {
    prepareFallback: vi.fn(async () => {
      if (options.fallbackPrepareDelay)
        await new Promise((r) => setTimeout(r, options.fallbackPrepareDelay));
    }),
    observe: vi.fn(async (a) => {
      observations.push(a);
    }),
    selectDelivery: vi.fn(async () => {
      if (options.selectionDelay) await new Promise((r) => setTimeout(r, options.selectionDelay));
    }),
  };
  const controller = new AbortController();
  const forward = vi.fn(
    async (model: TransportModel, signal: AbortSignal, onDispatch: () => void) => {
      if (options.routeDelay) await new Promise((r) => setTimeout(r, options.routeDelay));
      signal.throwIfAborted();
      onDispatch();
      const fallback = calls.length > 0;
      const call = { model, cancelled: false };
      calls.push(call);
      const id = fallback ? 'fallback-gen' : 'primary-gen';
      if (!fallback && options.headersDelay) {
        await new Promise((r) => setTimeout(r, options.headersDelay));
        signal.throwIfAborted();
      }
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          const send = (text: string) => stream.enqueue(new TextEncoder().encode(text));
          if (options.controls)
            setTimeout(() => {
              if (!call.cancelled)
                send(
                  `data: ${JSON.stringify({ id, choices: [{ delta: { role: 'assistant', reasoning: 'hidden' } }] })}\n\ndata: {"choices":[{"delta":{"content":" "}}]}\n\n`
                );
            }, 10);
          const reasoningAt = fallback ? options.fallbackReasoningAt : options.reasoningAt;
          if (reasoningAt !== undefined) {
            setTimeout(() => {
              if (!call.cancelled) {
                const delta = options.legacyReasoning
                  ? { content: '<thi' }
                  : { reasoning_content: fallback ? '兜底思考' : '首发思考' };
                send(`data: ${JSON.stringify({ id, choices: [{ delta }] })}\n\n`);
              }
            }, reasoningAt);
            if (options.legacyReasoning)
              setTimeout(() => {
                if (!call.cancelled) send(token(id, 'nk>真实思考</think>'));
              }, reasoningAt + 1);
          }
          const timer = setTimeout(
            () => {
              if (!call.cancelled) send(token(id, fallback ? '兜底' : '首发'));
            },
            fallback ? (options.fallbackAt ?? 8) : options.primaryAt
          );
          signal.addEventListener(
            'abort',
            () => {
              if (!call.cancelled) {
                call.cancelled = true;
                clearTimeout(timer);
                stream.error(signal.reason);
              }
            },
            { once: true }
          );
        },
        cancel() {
          call.cancelled = true;
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
  );
  const result = forwardWithFirstTokenFallback({
    primary: options.primary ?? { provider: 'venice', providerModelId: 'selected' },
    primaryAttemptId: 'primary-id',
    deferPersistence: options.deferPersistence,
    fallbackModelId: options.fallbackModelId,
    thinkingEnabled: options.thinkingEnabled ?? false,
    timeoutMs: options.timeoutMs ?? 40,
    remainingFirstTokenMs: options.totalMs ?? 100,
    fallbackTimeoutMs: options.fallbackTimeoutMs ?? 20,
    remainingObservationMs: 110_000,
    requestStartedAt: performance.now(),
    signal: controller.signal,
    store,
    forward,
    onObservationError: vi.fn(),
  });
  // Attach an immediate handler because fake-clock advance can reject before the assertion awaits.
  void result.catch(() => {});
  return { result, store, calls, observations, controller };
}

describe('first-token fallback budget and delivery', () => {
  it('keeps the primary when content is observed before its threshold', async () => {
    const test = setup({ primaryAt: 20 });
    await vi.advanceTimersByTimeAsync(21);
    const delivered = await test.result;
    expect(delivered.role).toBe('primary');
    expect(test.calls).toHaveLength(1);
    expect(test.store.selectDelivery).toHaveBeenCalledOnce();
    const reader = delivered.response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('首发');
    await reader.cancel();
    expect(test.observations.find((a) => a.first_token_ms !== undefined)?.first_token_ms).toBe(20);
  });
  it('switches at the primary wait boundary without dispatching twice', async () => {
    const test = setup({ primaryAt: 40 });
    await vi.advanceTimersByTimeAsync(49);
    const delivered = await test.result;
    expect(delivered.role).toBe('fallback');
    expect(test.calls).toHaveLength(2);
    await delivered.response.body?.cancel();
  });
  it('never switches back to a late primary, but records its exact first token', async () => {
    const test = setup({ primaryAt: 55, controls: true });
    await vi.advanceTimersByTimeAsync(11);
    expect(
      test.observations.some(
        (a) => a.generation_id === 'primary-gen' && a.first_token_ms === undefined
      )
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(45);
    const delivered = await test.result;
    expect(delivered.role).toBe('fallback');
    expect(delivered.model.providerModelId).toBe(FIRST_TOKEN_FALLBACK_MODEL_ID);
    const reader = delivered.response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('兜底');
    expect(first).not.toContain('首发');
    await reader.cancel();
    expect(test.store.prepareFallback).toHaveBeenCalledOnce();
    expect(
      test.observations.find((a) => a.role === 'primary' && a.first_token_ms !== undefined)
        ?.first_token_ms
    ).toBe(55);
    expect(test.calls[0]?.cancelled).toBe(true);
  });
  it('stops both attempts when fallback reaches its own 2s budget', async () => {
    const test = setup({ primaryAt: 100, fallbackAt: 30 });
    await vi.advanceTimersByTimeAsync(61);
    await expect(test.result).rejects.toMatchObject({ stage: 'fallback' });
    expect(test.calls.every((c) => c.cancelled)).toBe(true);
    expect(test.store.selectDelivery).not.toHaveBeenCalled();
    expect(test.observations).toContainEqual(
      expect.objectContaining({
        role: 'fallback',
        end_reason: 'first_token_deadline',
        observed_until_ms: 20,
      })
    );
  });
  it('counts model waits from actual dispatch and does not charge slow preparation to fallback', async () => {
    const test = setup({
      primaryAt: 90,
      fallbackAt: 15,
      routeDelay: 10,
      fallbackPrepareDelay: 15,
      totalMs: 150,
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(test.store.prepareFallback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(41);
    const result = await test.result;
    expect(test.store.prepareFallback).toHaveBeenCalledWith(expect.anything(), 50);
    expect(test.observations).toContainEqual(
      expect.objectContaining({ role: 'fallback', dispatch_offset_ms: 75, first_token_ms: 15 })
    );
    await result.response.body?.cancel();
    test.controller.abort();
  });
  it('the absolute deadline truncates a stalled fallback preparation without dispatching it', async () => {
    const test = setup({ primaryAt: 200, fallbackPrepareDelay: 80, totalMs: 100 });
    await vi.advanceTimersByTimeAsync(101);
    await expect(test.result).rejects.toMatchObject({ stage: 'global' });
    expect(test.calls).toHaveLength(1);
    expect(test.calls[0]?.cancelled).toBe(true);
  });
  it('skips an undispatched primary when only fallback budget remains', async () => {
    const test = setup({ primaryAt: 5, totalMs: 20 });
    await vi.advanceTimersByTimeAsync(6);
    const delivered = await test.result;
    expect(delivered.role).toBe('fallback');
    expect(test.calls).toHaveLength(1);
    expect(test.calls[0]?.model.providerModelId).toBe(FIRST_TOKEN_FALLBACK_MODEL_ID);
    const skipped = test.observations.find((a) => a.role === 'primary');
    expect(skipped).toMatchObject({ end_reason: 'budget_skipped' });
    expect(skipped?.dispatch_offset_ms).toBeUndefined();
    await delivered.response.body?.cancel();
  });
  it('does not wait for primary HTTP headers before starting the fallback threshold', async () => {
    const test = setup({ primaryAt: 5, headersDelay: 80 });
    await vi.advanceTimersByTimeAsync(49);
    const delivered = await test.result;
    expect(delivered.role).toBe('fallback');
    expect(test.store.prepareFallback).toHaveBeenCalledWith(expect.anything(), 40);
    await delivered.response.body?.cancel();
    test.controller.abort();
    await vi.advanceTimersByTimeAsync(40);
  });
  it('allows durable delivery selection to finish after the 6s SLA threshold', async () => {
    const test = setup({ primaryAt: 20, selectionDelay: 50 });
    await vi.advanceTimersByTimeAsync(71);
    const delivered = await test.result;
    expect(delivered.role).toBe('primary');
    expect(test.observations.find((a) => a.first_token_ms !== undefined)?.first_token_ms).toBe(20);
    expect(test.calls[0]?.cancelled).toBe(false);
    await delivered.response.body?.cancel();
  });
  it('dispatches the operator-selected fallback and records the same model identity', async () => {
    const test = setup({ primaryAt: 55, fallbackModelId: 'vendor/operator-flash' });
    await vi.advanceTimersByTimeAsync(50);
    const delivered = await test.result;
    expect(delivered.model).toEqual({
      provider: 'openrouter',
      providerModelId: 'vendor/operator-flash',
    });
    expect(test.store.prepareFallback).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'vendor/operator-flash' }),
      40
    );
    expect(test.store.selectDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'vendor/operator-flash', role: 'fallback' })
    );
    await delivered.response.body?.cancel();
    test.controller.abort();
  });
  it('does not dispatch the same model twice and still enforces its primary wait', async () => {
    const test = setup({
      primaryAt: 55,
      primary: { provider: 'openrouter', providerModelId: 'vendor/operator-flash' },
      fallbackModelId: 'vendor/operator-flash',
    });
    await vi.advanceTimersByTimeAsync(41);
    await expect(test.result).rejects.toMatchObject({ stage: 'primary' });
    expect(test.calls).toHaveLength(1);
    expect(test.calls[0]?.cancelled).toBe(true);
    expect(test.store.prepareFallback).not.toHaveBeenCalled();
  });
  it('honors cancellation while waiting for the first token', async () => {
    const test = setup({ primaryAt: 55 });
    await vi.advanceTimersByTimeAsync(12);
    test.controller.abort(new Error('cancelled'));
    await vi.advanceTimersByTimeAsync(1);
    await expect(test.result).rejects.toThrow('cancelled');
    expect(test.store.prepareFallback).not.toHaveBeenCalled();
  });
  it('does not fallback on an early HTTP rejection', async () => {
    const store = {
      prepareFallback: vi.fn(),
      observe: vi.fn(async () => {}),
      selectDelivery: vi.fn(),
    };
    const result = await forwardWithFirstTokenFallback({
      primary: { provider: 'openrouter', providerModelId: 'selected' },
      primaryAttemptId: 'p',
      timeoutMs: 40,
      fallbackTimeoutMs: 20,
      remainingFirstTokenMs: 100,
      remainingObservationMs: 300,
      requestStartedAt: performance.now(),
      signal: new AbortController().signal,
      store,
      forward: async () => new Response('rejected', { status: 503 }),
      onObservationError: vi.fn(),
    });
    expect(result.response.status).toBe(503);
    expect(store.prepareFallback).not.toHaveBeenCalled();
  });
  it('reads an EOF token without a trailing newline', async () => {
    const store = {
      prepareFallback: vi.fn(),
      observe: vi.fn(async () => {}),
      selectDelivery: vi.fn(async () => {}),
    };
    const result = await forwardWithFirstTokenFallback({
      primary: { provider: 'openrouter', providerModelId: 'selected' },
      primaryAttemptId: 'p',
      timeoutMs: 40,
      fallbackTimeoutMs: 20,
      remainingFirstTokenMs: 100,
      remainingObservationMs: 300,
      requestStartedAt: performance.now(),
      signal: new AbortController().signal,
      store,
      forward: async () => new Response(token('g', '字').trimEnd()),
      onObservationError: vi.fn(),
    });
    expect(await result.response.text()).toContain('字');
    expect(store.selectDelivery).toHaveBeenCalledOnce();
  });

  it('enabled reasoning at 3s locks primary and permits its answer at 10s beyond both thresholds', async () => {
    const test = setup({
      primaryAt: 10_000,
      reasoningAt: 3000,
      thinkingEnabled: true,
      timeoutMs: 4000,
      totalMs: 10_000,
    });
    await vi.advanceTimersByTimeAsync(3001);
    const delivered = await test.result;
    expect(delivered.role).toBe('primary');
    expect(test.store.selectDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ first_token_ms: 3000, end_reason: 'first_token_observed' })
    );
    const reader = delivered.response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('首发思考');
    const body = reader.read();
    await vi.advanceTimersByTimeAsync(7000);
    expect(new TextDecoder().decode((await body).value)).toContain('首发');
    expect(test.calls).toHaveLength(1);
    expect(test.calls[0]?.cancelled).toBe(false);
    expect(test.store.prepareFallback).not.toHaveBeenCalled();
    await reader.cancel();
  });

  it('silent thinking uses the same primary wait and falls back', async () => {
    const test = setup({ primaryAt: 100, thinkingEnabled: true });
    await vi.advanceTimersByTimeAsync(49);
    const delivered = await test.result;
    expect(delivered.role).toBe('fallback');
    expect(test.calls).toHaveLength(2);
    await delivered.response.body?.cancel();
    test.controller.abort();
  });
  it('disabled reasoning cannot stop the fallback stage timeout', async () => {
    const test = setup({
      primaryAt: 100,
      fallbackAt: 100,
      reasoningAt: 10,
      fallbackReasoningAt: 5,
      thinkingEnabled: false,
    });
    await vi.advanceTimersByTimeAsync(61);
    await expect(test.result).rejects.toMatchObject({ stage: 'fallback' });
    expect(test.store.selectDelivery).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'leading split think tags are not body; reasoning counts only when on=%s',
    async (thinkingEnabled) => {
      const test = setup({
        primaryAt: 55,
        reasoningAt: 10,
        legacyReasoning: true,
        thinkingEnabled,
      });
      await vi.advanceTimersByTimeAsync(56);
      const delivered = await test.result;
      expect(delivered.role).toBe(thinkingEnabled ? 'primary' : 'fallback');
      expect(
        test.observations.find((a) => a.role === 'primary' && a.first_token_ms !== undefined)
          ?.first_token_ms
      ).toBe(thinkingEnabled ? 11 : 55);
      await delivered.response.body?.cancel();
      test.controller.abort();
    }
  );
});

it('does not let a delayed primary token beat an overdue timer callback', async () => {
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const store = {
    prepareFallback: vi.fn(async () => {}),
    observe: vi.fn(async () => {}),
    selectDelivery: vi.fn(async () => {}),
  };
  try {
    const delivered = await forwardWithFirstTokenFallback({
      primary: { provider: 'openrouter', providerModelId: 'vendor/primary' },
      primaryAttemptId: 'p',
      fallbackModelId: 'vendor/fallback',
      timeoutMs: 40,
      fallbackTimeoutMs: 20,
      remainingFirstTokenMs: 100,
      remainingObservationMs: 300,
      requestStartedAt: 0,
      signal: new AbortController().signal,
      store,
      onObservationError: vi.fn(),
      forward: async (model, _signal, onDispatch) => {
        onDispatch();
        if (model.providerModelId === 'vendor/primary') now = 50;
        return new Response(token('g', '字'));
      },
    });
    expect(delivered.role).toBe('fallback');
    expect(store.selectDelivery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ role: 'fallback' })
    );
    await delivered.response.body?.cancel();
  } finally {
    clock.mockRestore();
  }
});

it('delivers fallback bytes before slow intent/identity persistence, but exposes a settlement gate', async () => {
  const { result, calls } = setup({
    primaryAt: 500,
    fallbackAt: 8,
    fallbackPrepareDelay: 70,
    selectionDelay: 50,
    deferPersistence: true,
  });
  let delivered = false;
  void result.then(() => {
    delivered = true;
  });
  await vi.advanceTimersByTimeAsync(49);
  expect(delivered).toBe(true);
  expect(calls).toHaveLength(2);
  const response = await result;
  expect(response.role).toBe('fallback');
  const reader = response.response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('兜底');
  let persisted = false;
  void response.deliveryPersisted.then(() => {
    persisted = true;
  });
  expect(persisted).toBe(false);
  await vi.advanceTimersByTimeAsync(120);
  expect(persisted).toBe(true);
  await reader.cancel();
});
