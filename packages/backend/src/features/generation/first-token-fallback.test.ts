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
  it('a primary ready at its trigger boundary remains eligible and cancels the other attempt', async () => {
    const test = setup({ primaryAt: 40 });
    await vi.advanceTimersByTimeAsync(49);
    const delivered = await test.result;
    expect(delivered.role).toBe('primary');
    expect(test.calls).toHaveLength(2);
    expect(test.calls[1]?.cancelled).toBe(true);
    expect(test.store.selectDelivery).toHaveBeenCalledOnce();
    await delivered.response.body?.cancel();
  });
  it('a fallback winner immediately cancels primary without waiting to observe its later token', async () => {
    const test = setup({ primaryAt: 55, controls: true });
    await vi.advanceTimersByTimeAsync(11);
    expect(test.observations).toHaveLength(1);
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
    expect(test.observations.find((a) => a.role === 'primary' && a.end_reason)).toMatchObject({
      generation_id: 'primary-gen',
      end_reason: 'cancelled',
      observed_until_ms: 48,
      discarded_response: { reason: 'race_lost', content: '', reasoning: '', truncated: false },
    });
    expect(
      test.observations.some((a) => a.role === 'primary' && a.first_token_ms !== undefined)
    ).toBe(false);
    expect(test.calls[0]?.cancelled).toBe(true);
    expect(test.observations.filter((a) => a.role === 'primary')).toHaveLength(2);
    expect(test.observations.filter((a) => a.role === 'fallback')).toHaveLength(2);
  });
  it('fallback may win after its old 2s stage budget while still inside the total budget', async () => {
    const test = setup({ primaryAt: 100, fallbackAt: 30 });
    await vi.advanceTimersByTimeAsync(71);
    const delivered = await test.result;
    expect(delivered.role).toBe('fallback');
    expect(delivered.firstTokenAt).toBe(70);
    expect(test.calls[0]?.cancelled).toBe(true);
    expect(test.store.selectDelivery).toHaveBeenCalledOnce();
    await delivered.response.body?.cancel();
  });
  it('a primary arriving after fallback starts can still win and cancel fallback immediately', async () => {
    const test = setup({ primaryAt: 50, fallbackAt: 20 });
    await vi.advanceTimersByTimeAsync(51);
    const delivered = await test.result;
    expect(delivered.role).toBe('primary');
    expect(delivered.firstTokenAt).toBe(50);
    expect(test.calls[1]?.cancelled).toBe(true);
    expect(test.store.selectDelivery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ role: 'primary' })
    );
    const reader = delivered.response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('首发');
    await reader.cancel();
  });
  it('the common absolute deadline cancels both silent attempts exactly once', async () => {
    const test = setup({ primaryAt: 100, fallbackAt: 100 });
    await vi.advanceTimersByTimeAsync(101);
    await expect(test.result).rejects.toMatchObject({ stage: 'global' });
    expect(test.calls).toHaveLength(2);
    expect(test.calls.every((c) => c.cancelled)).toBe(true);
    expect(test.store.selectDelivery).not.toHaveBeenCalled();
    expect(test.observations.filter((a) => a.end_reason === 'first_token_deadline')).toHaveLength(
      2
    );
    expect(test.observations).toHaveLength(4);
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
  it('the same model uses one POST and may deliver after the primary trigger up to the total deadline', async () => {
    const test = setup({
      primaryAt: 55,
      primary: { provider: 'openrouter', providerModelId: 'vendor/operator-flash' },
      fallbackModelId: 'vendor/operator-flash',
    });
    await vi.advanceTimersByTimeAsync(56);
    const delivered = await test.result;
    expect(delivered.role).toBe('primary');
    expect(test.calls).toHaveLength(1);
    expect(test.calls[0]?.cancelled).toBe(false);
    expect(test.store.prepareFallback).not.toHaveBeenCalled();
    await delivered.response.body?.cancel();
  });
  it('the same silent model is stopped at the total deadline without a duplicate POST', async () => {
    const test = setup({
      primaryAt: 100,
      primary: { provider: 'openrouter', providerModelId: 'vendor/operator-flash' },
      fallbackModelId: 'vendor/operator-flash',
    });
    await vi.advanceTimersByTimeAsync(101);
    await expect(test.result).rejects.toMatchObject({ stage: 'global' });
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
  it.each([
    'http_401',
    'http_403',
    'http_429',
    'http_503',
    'missing_body',
    'connect_error',
    'read_error',
    'empty_eof',
    'empty_done',
    'stream_error',
    'choice_error',
    'event_error',
    'event_error_text',
    'refusal',
    'finish_without_delta',
    'finish_empty_delta',
  ])('immediately falls back on %s before the first visible token', async (failure) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const observations: AttemptObservation[] = [];
    const cancelled = vi.fn();
    const store = {
      prepareFallback: vi.fn(async () => {}),
      observe: vi.fn(async (a: AttemptObservation) => {
        observations.push(a);
      }),
      selectDelivery: vi.fn(async () => {}),
    };
    let calls = 0;
    const result = forwardWithFirstTokenFallback({
      primary: { provider: 'openrouter', providerModelId: 'selected' },
      primaryAttemptId: 'p',
      timeoutMs: 4000,
      fallbackTimeoutMs: 2000,
      remainingFirstTokenMs: 10000,
      remainingObservationMs: 110000,
      requestStartedAt: performance.now(),
      signal: new AbortController().signal,
      store,
      forward: async (_model, _signal, onDispatch) => {
        onDispatch();
        if (++calls === 2) return new Response(token('fallback-id', '兜底'));
        if (failure.startsWith('http_'))
          return new Response('rejected', { status: Number(failure.slice(5)) });
        if (failure === 'missing_body') return new Response(null);
        if (failure === 'connect_error') throw new Error('connection reset');
        if (failure === 'empty_eof')
          return new Response('data: {"choices":[{"delta":{"content":" "}}]}\n\n');
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              if (failure === 'read_error') {
                c.error(new Error('read failed'));
                return;
              }
              const frames: Record<string, string> = {
                empty_done: 'data: [DONE]\n\n',
                stream_error: 'data: {"id":"failed-id","error":{"code":503}}\n\n',
                choice_error: 'data: {"choices":[{"error":{"code":503}}]}\n\n',
                event_error: 'event: error\ndata: {"message":"unavailable"}\n\n',
                event_error_text: 'event: error\ndata: Service unavailable\n\n',
                refusal: 'data: {"choices":[{"delta":{"refusal":"unavailable"}}]}\n\n',
                finish_without_delta: 'data: {"choices":[{"finish_reason":"content_filter"}]}\n\n',
                finish_empty_delta: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
              };
              c.enqueue(new TextEncoder().encode(frames[failure]));
              // Deliberately do not close: terminal protocol events must not wait for EOF.
            },
            cancel: cancelled,
          })
        );
      },
      onObservationError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(1);
    const delivered = await result;
    expect(delivered.role).toBe('fallback');
    expect(calls).toBe(2);
    expect(store.prepareFallback).toHaveBeenCalledWith(expect.anything(), 0);
    expect(store.selectDelivery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ role: 'fallback' })
    );
    expect(observations).toContainEqual(
      expect.objectContaining({
        role: 'primary',
        end_reason: expect.stringMatching(/upstream_error|stream_interrupted/),
      })
    );
    if (failure === 'stream_error')
      expect(observations).toContainEqual(expect.objectContaining({ generation_id: 'failed-id' }));
    if (
      [
        'empty_done',
        'stream_error',
        'choice_error',
        'event_error',
        'event_error_text',
        'refusal',
        'finish_without_delta',
        'finish_empty_delta',
      ].includes(failure)
    )
      expect(cancelled).toHaveBeenCalled();
    await delivered.response.body?.cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(2);
  });

  it('retries the same fallback model once after failure and clears its primary deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let calls = 0;
    const result = forwardWithFirstTokenFallback({
      primary: { provider: 'openrouter', providerModelId: FIRST_TOKEN_FALLBACK_MODEL_ID },
      primaryAttemptId: 'p',
      timeoutMs: 40,
      fallbackTimeoutMs: 100,
      remainingFirstTokenMs: 200,
      remainingObservationMs: 300,
      requestStartedAt: performance.now(),
      signal: new AbortController().signal,
      store: {
        prepareFallback: vi.fn(async () => {}),
        observe: vi.fn(async () => {}),
        selectDelivery: vi.fn(async () => {}),
      },
      forward: async (_model, _signal, dispatch) => {
        dispatch();
        if (++calls === 1) return new Response(null, { status: 503 });
        await new Promise((resolve) => setTimeout(resolve, 60));
        return new Response(token('fallback', '恢复'));
      },
      onObservationError: vi.fn(),
    });
    void result.catch(() => {});
    await vi.advanceTimersByTimeAsync(61);
    expect((await result).role).toBe('fallback');
    expect(calls).toBe(2);
    await (await result).response.body?.cancel();
  });

  it('reassembles a split error frame and falls back before EOF or the threshold', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let calls = 0;
    const result = forwardWithFirstTokenFallback({
      primary: { provider: 'venice', providerModelId: 'selected' },
      primaryAttemptId: 'p',
      timeoutMs: 4000,
      fallbackTimeoutMs: 2000,
      remainingFirstTokenMs: 10000,
      remainingObservationMs: 110000,
      requestStartedAt: performance.now(),
      signal: new AbortController().signal,
      store: {
        prepareFallback: vi.fn(async () => {}),
        observe: vi.fn(async () => {}),
        selectDelivery: vi.fn(async () => {}),
      },
      forward: async (_model, _signal, dispatch) => {
        dispatch();
        if (++calls === 2) return new Response(token('f', '兜底'));
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('data: {"err'));
              setTimeout(() => c.enqueue(new TextEncoder().encode('or":{"code":503}}\n\n')), 5);
            },
          })
        );
      },
      onObservationError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(6);
    expect((await result).role).toBe('fallback');
    expect(calls).toBe(2);
    await (await result).response.body?.cancel();
  });

  it.each([
    'user_cancelled',
    'global_expired',
    'fallback_failed',
    'token_before_error',
    'reasoning_before_error',
  ])('respects the no-more-attempts boundary: %s', async (scenario) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const controller = new AbortController();
    let calls = 0;
    const store = {
      prepareFallback: vi.fn(async () => {}),
      observe: vi.fn(async () => {}),
      selectDelivery: vi.fn(async () => {}),
    };
    const result = forwardWithFirstTokenFallback({
      primary: { provider: 'venice', providerModelId: 'selected' },
      primaryAttemptId: 'p',
      thinkingEnabled: true,
      timeoutMs: 4000,
      fallbackTimeoutMs: 2000,
      remainingFirstTokenMs: 10000,
      remainingObservationMs: 110000,
      requestStartedAt: performance.now(),
      signal: controller.signal,
      store,
      forward: async (_model, _signal, dispatch) => {
        calls++;
        if (scenario !== 'global_expired') dispatch();
        if (scenario === 'user_cancelled') {
          controller.abort(new Error('user cancelled'));
          throw new Error('connection closed');
        }
        if (scenario === 'global_expired') {
          await new Promise((resolve) => setTimeout(resolve, 10001));
          throw new Error('late failure');
        }
        if (scenario === 'token_before_error' || scenario === 'reasoning_before_error') {
          const first =
            scenario === 'token_before_error'
              ? token('p', '可见正文')
              : 'data: {"choices":[{"delta":{"reasoning":"公开思考"}}]}\n\n';
          return new Response(first + 'data: {"error":{"code":503}}\n\n');
        }
        return new Response(null, { status: 503 });
      },
      onObservationError: vi.fn(),
    });
    void result.catch(() => {});
    await vi.advanceTimersByTimeAsync(scenario === 'global_expired' ? 10002 : 1);
    if (scenario === 'user_cancelled') await expect(result).rejects.toThrow('user cancelled');
    else if (scenario === 'global_expired')
      await expect(result).rejects.toMatchObject({ stage: 'global' });
    else {
      const delivered = await result;
      expect(delivered.role).toBe(scenario === 'fallback_failed' ? 'fallback' : 'primary');
      await delivered.response.body?.cancel();
    }
    expect(calls).toBe(scenario === 'fallback_failed' ? 2 : 1);
    expect(store.prepareFallback).toHaveBeenCalledTimes(scenario === 'fallback_failed' ? 1 : 0);
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
  it('disabled reasoning cannot stop the common first-token deadline', async () => {
    const test = setup({
      primaryAt: 100,
      fallbackAt: 100,
      reasoningAt: 10,
      fallbackReasoningAt: 5,
      thinkingEnabled: false,
    });
    await vi.advanceTimersByTimeAsync(101);
    await expect(test.result).rejects.toMatchObject({ stage: 'global' });
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
      ).toBe(thinkingEnabled ? 11 : undefined);
      await delivered.response.body?.cancel();
      test.controller.abort();
    }
  );
});

it('an overdue trigger does not discard an already ready primary inside the total deadline', async () => {
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
    expect(delivered.role).toBe('primary');
    expect(store.selectDelivery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ role: 'primary' })
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

it.each([
  { winningRole: 'primary', raw: '旧'.repeat(3000), expected: '旧'.repeat(2048) },
  { winningRole: 'fallback', raw: '旧'.repeat(2047) + '😀tail', expected: '旧'.repeat(2047) },
])(
  'same-batch tokens lock $winningRole once, abort the loser and save bounded Unicode-safe text',
  async ({ winningRole, raw, expected }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const attempts: Array<{
      controller: ReadableStreamDefaultController<Uint8Array>;
      signal: AbortSignal;
      cancelled: ReturnType<typeof vi.fn>;
    }> = [];
    const observations: AttemptObservation[] = [];
    const store = {
      prepareFallback: vi.fn(async () => {}),
      observe: vi.fn(async (attempt: AttemptObservation) => {
        observations.push(attempt);
      }),
      selectDelivery: vi.fn(async () => {}),
    };
    const onReady = vi.fn();
    const response = forwardWithFirstTokenFallback({
      primary: { provider: 'openrouter', providerModelId: 'primary' },
      primaryAttemptId: 'primary-id',
      timeoutMs: 40,
      fallbackTimeoutMs: 20,
      remainingFirstTokenMs: 100,
      remainingObservationMs: 300,
      requestStartedAt: performance.now(),
      signal: new AbortController().signal,
      store,
      onReady,
      thinkingEnabled: true,
      deferPersistence: true,
      onObservationError: vi.fn(),
      forward: async (_model, signal, onDispatch) => {
        onDispatch();
        const cancelled = vi.fn();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            attempts.push({ controller, signal, cancelled });
          },
          cancel: cancelled,
        });
        return new Response(stream);
      },
    });
    await vi.advanceTimersByTimeAsync(41);
    expect(attempts).toHaveLength(2);
    const winningIndex = winningRole === 'primary' ? 0 : 1;
    const losingIndex = 1 - winningIndex;
    attempts[winningIndex]!.controller.enqueue(new TextEncoder().encode(token('winner', '赢家')));
    attempts[losingIndex]!.controller.enqueue(
      new TextEncoder().encode(
        `data:${JSON.stringify({ id: 'loser', choices: [{ delta: { content: raw, reasoning: raw.replaceAll('旧', '思') } }] })}\n\n`
      )
    );
    const selected = await response;
    await vi.advanceTimersByTimeAsync(0);
    expect(selected.role).toBe(winningRole);
    expect(attempts[losingIndex]!.signal.aborted).toBe(true);
    expect(attempts[losingIndex]!.cancelled).toHaveBeenCalledOnce();
    expect(attempts[winningIndex]!.signal.aborted).toBe(false);
    expect(onReady).toHaveBeenCalledOnce();
    expect(store.selectDelivery).toHaveBeenCalledOnce();
    const reader = selected.response.body!.getReader();
    const delivered = new TextDecoder().decode((await reader.read()).value);
    expect(delivered).toContain('赢家');
    expect(delivered).not.toContain('旧');
    const losingObservation = observations.find((a) => a.discarded_response);
    expect(losingObservation?.first_token_ms).toBe(winningRole === 'primary' ? 1 : 41);
    const discarded = losingObservation?.discarded_response;
    expect(discarded).toEqual({
      reason: 'race_lost',
      content: expected,
      reasoning: expected.replaceAll('旧', '思'),
      truncated: true,
    });
    expect(observations).toHaveLength(4);
    for (const role of ['primary', 'fallback'])
      expect(observations.filter((a) => a.role === role)).toHaveLength(2);
    await reader.cancel();
  }
);

it('a fallback failure leaves an in-flight primary eligible until the common deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let count = 0;
  const store = {
    prepareFallback: vi.fn(async () => {}),
    observe: vi.fn(async () => {}),
    selectDelivery: vi.fn(async () => {}),
  };
  const result = forwardWithFirstTokenFallback({
    primary: { provider: 'openrouter', providerModelId: 'primary' },
    primaryAttemptId: 'p',
    timeoutMs: 40,
    fallbackTimeoutMs: 20,
    remainingFirstTokenMs: 100,
    remainingObservationMs: 300,
    requestStartedAt: performance.now(),
    signal: new AbortController().signal,
    store,
    onObservationError: vi.fn(),
    forward: async (_model, signal, onDispatch) => {
      onDispatch();
      if (++count === 2) return new Response(null, { status: 503 });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const timer = setTimeout(
              () => controller.enqueue(new TextEncoder().encode(token('primary', '首发可用'))),
              70
            );
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                controller.error(signal.reason);
              },
              { once: true }
            );
          },
        })
      );
    },
  });
  await vi.advanceTimersByTimeAsync(71);
  const selected = await result;
  expect(selected.role).toBe('primary');
  expect(count).toBe(2);
  expect(store.selectDelivery).toHaveBeenCalledOnce();
  await selected.response.body?.cancel();
});

it('a primary winner does not await a slow fallback intent and the cancelled fallback never dispatches later', async () => {
  const test = setup({ primaryAt: 50, fallbackPrepareDelay: 120 });
  let returned = false;
  void test.result.then(() => {
    returned = true;
  });
  await vi.advanceTimersByTimeAsync(51);
  expect(returned).toBe(true);
  const selected = await test.result;
  expect(selected.role).toBe('primary');
  expect(test.calls).toHaveLength(1);
  expect(test.store.selectDelivery).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(150);
  expect(test.calls).toHaveLength(1);
  expect(test.observations.find((a) => a.role === 'fallback')).toMatchObject({
    end_reason: 'cancelled',
    discarded_response: { reason: 'race_lost', content: '', reasoning: '', truncated: false },
  });
  await selected.response.body?.cancel();
});

it('slow or failed diagnostic writes never delay first-token delivery', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let count = 0;
  const onObservationError = vi.fn();
  const store = {
    prepareFallback: vi.fn(async () => {}),
    observe: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 200));
      throw new Error('observation unavailable');
    }),
    selectDelivery: vi.fn(async () => {}),
  };
  const result = forwardWithFirstTokenFallback({
    primary: { provider: 'openrouter', providerModelId: 'primary' },
    primaryAttemptId: 'p',
    timeoutMs: 40,
    fallbackTimeoutMs: 20,
    remainingFirstTokenMs: 100,
    remainingObservationMs: 300,
    requestStartedAt: performance.now(),
    signal: new AbortController().signal,
    store,
    deferPersistence: true,
    onObservationError,
    forward: async (_model, _signal, onDispatch) => {
      onDispatch();
      if (++count === 2) return new Response(token('f', '兜底'));
      return new Response(new ReadableStream<Uint8Array>());
    },
  });
  let returned = false;
  void result.then(() => {
    returned = true;
  });
  await vi.advanceTimersByTimeAsync(41);
  expect(returned).toBe(true);
  const selected = await result;
  expect(selected.role).toBe('fallback');
  await selected.deliveryPersisted;
  expect(onObservationError).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(400);
  expect(onObservationError).toHaveBeenCalledTimes(4);
  expect(store.observe).toHaveBeenCalledTimes(4);
  await selected.response.body?.cancel();
});

it('a cancelled loser whose transport ignores abort still has its late response body closed', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let count = 0;
  let lateResponse!: (response: Response) => void;
  const closed = vi.fn(),
    observations: AttemptObservation[] = [];
  const store = {
    prepareFallback: vi.fn(async () => {}),
    observe: vi.fn(async (a: AttemptObservation) => {
      observations.push(a);
    }),
    selectDelivery: vi.fn(async () => {}),
  };
  const result = forwardWithFirstTokenFallback({
    primary: { provider: 'openrouter', providerModelId: 'primary' },
    primaryAttemptId: 'p',
    timeoutMs: 40,
    fallbackTimeoutMs: 20,
    remainingFirstTokenMs: 100,
    remainingObservationMs: 300,
    requestStartedAt: performance.now(),
    signal: new AbortController().signal,
    store,
    onObservationError: vi.fn(),
    forward: async (_model, _signal, onDispatch) => {
      onDispatch();
      if (++count === 1)
        return new Promise<Response>((resolve) => {
          lateResponse = resolve;
        });
      return new Response(token('f', '赢家'));
    },
  });
  await vi.advanceTimersByTimeAsync(41);
  const selected = await result;
  expect(selected.role).toBe('fallback');
  expect(observations.filter((a) => a.role === 'primary')).toHaveLength(2);
  lateResponse(new Response(new ReadableStream<Uint8Array>({ cancel: closed })));
  await vi.advanceTimersByTimeAsync(0);
  expect(closed).toHaveBeenCalledOnce();
  expect(observations.filter((a) => a.role === 'primary')).toHaveLength(2);
  expect(store.selectDelivery).toHaveBeenCalledOnce();
  await selected.response.body?.cancel();
});

it.each([100, 101])(
  'an overdue deadline rejects a token at %s ms even before the timer callback executes',
  async (nowAtToken) => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const store = {
      prepareFallback: vi.fn(async () => {}),
      observe: vi.fn(async () => {}),
      selectDelivery: vi.fn(async () => {}),
    };
    try {
      await expect(
        forwardWithFirstTokenFallback({
          primary: { provider: 'openrouter', providerModelId: 'primary' },
          primaryAttemptId: 'p',
          timeoutMs: 40,
          fallbackTimeoutMs: 20,
          remainingFirstTokenMs: 100,
          remainingObservationMs: 300,
          requestStartedAt: 0,
          signal: new AbortController().signal,
          store,
          onObservationError: vi.fn(),
          forward: async (_model, _signal, onDispatch) => {
            onDispatch();
            now = nowAtToken;
            return new Response(token('late', '晚到'));
          },
        })
      ).rejects.toMatchObject({ stage: 'global' });
      expect(store.selectDelivery).not.toHaveBeenCalled();
      expect(store.prepareFallback).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  }
);
