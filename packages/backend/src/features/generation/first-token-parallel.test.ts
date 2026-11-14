import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  forwardWithFirstTokenFallback,
  type FirstTokenAttemptStore,
  type PersistGate,
  type TransportModel,
} from './first-token-fallback.js';
import type { AttemptObservation } from '../../infrastructure/repositories/GenerationObservationRepository.js';

vi.mock('../../lib/engineering-observability.js', () => ({
  observeChatFirstToken: vi.fn(),
  observeGenerationDispatch: vi.fn(),
  observeGenerationAttempt: vi.fn(),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** 每一路的剧本：多久出字，或多久报错（HTTP 状态）；都不填就一直不出字。 */
interface Plan {
  tokenAt?: number;
  failAt?: number;
}

interface Call {
  role: 'primary' | 'fallback';
  generationId: string;
  at: number;
  cancelled: boolean;
  gate?: PersistGate;
}

/**
 * 畅聊免费模型的多路主请求：7 秒内谁先出字谁胜出，其余取消；
 * 都失败才立刻兜底，到 7 秒还没人出字就和兜底一起竞争，总上限 10 秒。
 */
function race(primaries: Plan[], fallback: Plan = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const calls: Call[] = [];
  const observations: AttemptObservation[] = [];
  const store: FirstTokenAttemptStore = {
    prepareFallback: vi.fn(async () => {}),
    observe: vi.fn(async (attempt) => {
      observations.push(attempt);
    }),
    selectDelivery: vi.fn(async () => {}),
  };
  const controller = new AbortController();
  let primaryIndex = 0;
  const forward = vi.fn(
    async (
      _model: TransportModel,
      signal: AbortSignal,
      onDispatch: () => void,
      attempt: { role: 'primary' | 'fallback'; gate?: PersistGate }
    ) => {
      onDispatch();
      const index = attempt.role === 'primary' ? primaryIndex++ : -1;
      const plan = attempt.role === 'primary' ? (primaries[index] ?? {}) : fallback;
      const call: Call = {
        role: attempt.role,
        generationId: attempt.role === 'primary' ? `gen-p${index}` : 'gen-fb',
        at: performance.now(),
        cancelled: false,
        gate: attempt.gate,
      };
      calls.push(call);
      const headers = { 'content-type': 'text/event-stream', 'x-generation-id': call.generationId };
      if (plan.failAt !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, plan.failAt));
        signal.throwIfAborted();
        return new Response(null, { status: 404, headers });
      }
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          const timer =
            plan.tokenAt === undefined
              ? undefined
              : setTimeout(() => {
                  const frame = {
                    id: call.generationId,
                    choices: [{ delta: { content: '你好' } }],
                  };
                  stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
                }, plan.tokenAt);
          signal.addEventListener(
            'abort',
            () => {
              call.cancelled = true;
              clearTimeout(timer);
              stream.error(signal.reason);
            },
            { once: true }
          );
        },
      });
      return new Response(body, { headers });
    }
  );
  const result = forwardWithFirstTokenFallback({
    primary: { provider: 'surplus', providerModelId: 'glm-5' },
    primaryAttemptId: 'primary-id',
    primaryCount: primaries.length,
    thinkingEnabled: true,
    timeoutMs: 7_000,
    remainingFirstTokenMs: 10_000,
    fallbackTimeoutMs: 2_000,
    remainingObservationMs: 110_000,
    requestStartedAt: performance.now(),
    signal: controller.signal,
    store,
    forward,
    onObservationError: vi.fn(),
  });
  void result.catch(() => {});
  const persistedPrimaries = () => observations.filter((item) => item.role === 'primary');
  /** 落库的主请求快照来自哪几路（派出时的快照还没有调用 ID，不算）；只写一路时恰好两条：派出 + 结束 */
  const writtenFrom = () => {
    const written = persistedPrimaries();
    return {
      ids: new Set(written.flatMap((item) => (item.generation_id ? [item.generation_id] : []))),
      count: written.length,
    };
  };
  return { result, calls, store, persistedPrimaries, writtenFrom, controller };
}

describe('parallel primary requests', () => {
  it('the first primary to speak wins, the others are cancelled and never persisted', async () => {
    const test = race([{ tokenAt: 5_000 }, { tokenAt: 2_000 }, {}]);
    await vi.advanceTimersByTimeAsync(2_001);
    const delivered = await test.result;
    expect(delivered.role).toBe('primary');
    expect(test.calls.map((call) => call.role)).toEqual(['primary', 'primary', 'primary']);
    expect(test.calls.filter((call) => call.cancelled)).toHaveLength(2);
    // 三路共用一条主请求记录：只写胜出那一路
    const written = test.persistedPrimaries();
    expect(test.writtenFrom()).toEqual({ ids: new Set(['gen-p1']), count: 2 });
    expect(written.every((item) => item.id === 'primary-id')).toBe(true);
    expect(written.at(-1)?.end_reason).toBe('first_token_observed');
    expect(test.store.selectDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'primary-id', generation_id: 'gen-p1' })
    );
    await delivered.response.body?.cancel();
  });

  it('one failure does not start the fallback; all failing starts it right away', async () => {
    const test = race([{ failAt: 100 }, { failAt: 300 }], { tokenAt: 500 });
    await vi.advanceTimersByTimeAsync(200);
    expect(test.calls.some((call) => call.role === 'fallback')).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    const fallback = test.calls.find((call) => call.role === 'fallback');
    expect(fallback?.at).toBe(300);
    await vi.advanceTimersByTimeAsync(500);
    const delivered = await test.result;
    expect(delivered.role).toBe('fallback');
    // 全失败时以最后结束的那一路为准
    expect(test.writtenFrom()).toEqual({ ids: new Set(['gen-p1']), count: 2 });
    expect(test.persistedPrimaries().at(-1)?.end_reason).toBe('upstream_error');
    await delivered.response.body?.cancel();
  });

  it('after the wait every primary keeps racing the fallback, and a late primary can still win', async () => {
    const test = race([{}, {}, { tokenAt: 8_000 }], { tokenAt: 2_500 });
    await vi.advanceTimersByTimeAsync(7_000);
    expect(test.calls.find((call) => call.role === 'fallback')?.at).toBe(7_000);
    await vi.advanceTimersByTimeAsync(1_001);
    const delivered = await test.result;
    expect(delivered.role).toBe('primary');
    expect(test.calls.find((call) => call.role === 'fallback')?.cancelled).toBe(true);
    expect(test.writtenFrom()).toEqual({ ids: new Set(['gen-p2']), count: 2 });
    await delivered.response.body?.cancel();
  });

  it('when the fallback wins, the primary record comes from exactly one of the cancelled calls', async () => {
    const test = race([{}, {}], { tokenAt: 1_000 });
    await vi.advanceTimersByTimeAsync(8_001);
    const delivered = await test.result;
    expect(delivered.role).toBe('fallback');
    expect(test.calls.filter((call) => call.role === 'primary' && call.cancelled)).toHaveLength(2);
    const written = test.writtenFrom();
    expect(written.ids.size).toBe(1);
    expect(written.count).toBe(2);
    expect(test.persistedPrimaries().at(-1)?.end_reason).toBe('cancelled');
    await delivered.response.body?.cancel();
  });

  it('a single primary is not gated (unchanged behaviour)', async () => {
    const test = race([{ tokenAt: 1_000 }]);
    await vi.advanceTimersByTimeAsync(1_001);
    const delivered = await test.result;
    expect(delivered.role).toBe('primary');
    expect(test.calls[0]?.gate).toBeUndefined();
    await delivered.response.body?.cancel();
  });
});
