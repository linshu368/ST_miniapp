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
    timeoutMs: 40,
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
});
