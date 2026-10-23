import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIRST_TOKEN_FALLBACK_MODEL_ID } from '@miniapp/shared';
import {
  forwardWithFirstTokenFallback,
  FirstTokenDeadlineError,
  type FirstTokenAttemptStore,
  type TransportModel,
} from './first-token-fallback.js';
import type { AttemptObservation } from '../../infrastructure/repositories/GenerationObservationRepository.js';

afterEach(() => vi.useRealTimers());
const token = (id: string, text: string) =>
  `data:${JSON.stringify({ id, choices: [{ delta: { content: text } }] })}\n\n`;

function setup(options: {
  primaryAt: number;
  fallbackAt?: number;
  fallbackModelId?: string;
  deadline?: number;
  primary?: TransportModel;
  controls?: boolean;
  selectionDelay?: number;
  thinkingEnabled?: boolean;
  reasoningAt?: number;
  fallbackReasoningAt?: number;
  legacyReasoning?: boolean;
  timeoutMs?: number;
}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const calls: Array<{ model: TransportModel; cancelled: boolean }> = [];
  const observations: AttemptObservation[] = [];
  const store: FirstTokenAttemptStore = {
    prepareFallback: vi.fn(async () => {}),
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
      onDispatch();
      const fallback = calls.length > 0;
      const call = { model, cancelled: false };
      calls.push(call);
      const id = fallback ? 'fallback-gen' : 'primary-gen';
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
    fallbackModelId: options.fallbackModelId,
    thinkingEnabled: options.thinkingEnabled ?? false,
    timeoutMs: options.timeoutMs ?? 40,
    remainingFirstTokenMs: options.deadline ?? 60,
    remainingObservationMs: 300,
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
  it('keeps a primary token exactly at its wait boundary without dispatching twice', async () => {
    const test = setup({ primaryAt: 40 });
    await vi.advanceTimersByTimeAsync(41);
    const delivered = await test.result;
    expect(delivered.role).toBe('primary');
    expect(test.calls).toHaveLength(1);
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
  it('a late primary cannot satisfy the global deadline after fallback has begun', async () => {
    const test = setup({ primaryAt: 55, fallbackAt: 30 });
    await vi.advanceTimersByTimeAsync(61);
    await expect(test.result).rejects.toBeInstanceOf(FirstTokenDeadlineError);
    expect(test.store.selectDelivery).not.toHaveBeenCalled();
    expect(test.calls.every((c) => c.cancelled)).toBe(true);
  });
  it('does not give database delivery selection a fresh budget', async () => {
    const test = setup({ primaryAt: 20, selectionDelay: 50 });
    await vi.advanceTimersByTimeAsync(61);
    await expect(test.result).rejects.toBeInstanceOf(FirstTokenDeadlineError);
    expect(test.observations.find((a) => a.first_token_ms !== undefined)?.first_token_ms).toBe(20);
    expect(test.calls[0]?.cancelled).toBe(true);
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
  it('does not dispatch the configured fallback twice when it is already the primary', async () => {
    const test = setup({
      primaryAt: 55,
      primary: { provider: 'openrouter', providerModelId: 'vendor/operator-flash' },
      fallbackModelId: 'vendor/operator-flash',
    });
    await vi.advanceTimersByTimeAsync(56);
    const delivered = await test.result;
    expect(test.calls).toHaveLength(1);
    expect(test.store.prepareFallback).not.toHaveBeenCalled();
    await delivered.response.body?.cancel();
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
      remainingFirstTokenMs: 60,
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
      remainingFirstTokenMs: 60,
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
      deadline: 6000,
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

  it('enabled fallback reasoning stops the shared deadline and late primary cannot replace it', async () => {
    const test = setup({
      primaryAt: 55,
      fallbackAt: 100,
      fallbackReasoningAt: 5,
      thinkingEnabled: true,
    });
    await vi.advanceTimersByTimeAsync(46);
    const delivered = await test.result;
    expect(delivered.role).toBe('fallback');
    const reader = delivered.response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('兜底思考');
    await vi.advanceTimersByTimeAsync(100);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('兜底');
    expect(test.store.selectDelivery).toHaveBeenCalledOnce();
    expect(test.store.selectDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'fallback', first_token_ms: 5 })
    );
    expect(test.calls[0]?.cancelled).toBe(true);
    await reader.cancel();
  });

  it('off ignores reasoning from both attempts and preserves the global deadline', async () => {
    const test = setup({
      primaryAt: 100,
      fallbackAt: 100,
      reasoningAt: 10,
      fallbackReasoningAt: 5,
      thinkingEnabled: false,
    });
    await vi.advanceTimersByTimeAsync(61);
    await expect(test.result).rejects.toBeInstanceOf(FirstTokenDeadlineError);
    expect(test.store.selectDelivery).not.toHaveBeenCalled();
    expect(test.observations.every((a) => a.first_token_ms === undefined)).toBe(true);
    expect(test.calls.every((call) => call.cancelled)).toBe(true);
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
