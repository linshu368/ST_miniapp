import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const upstream = vi.hoisted(() => ({ forward: vi.fn(), resolve: vi.fn() }));
vi.mock('./upstream.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./upstream.js')>()),
  forwardToUpstream: upstream.forward,
  resolveProviderUpstream: upstream.resolve,
}));
import { compressStoryMemory, STORY_MEMORY_COMPRESS_TIMEOUT_MS } from './story-memory-compress.js';
import { storyMemoryRoute } from './surplus-route.js';

const input = {
  model: 'deepseek-v4.1-flash-1017',
  route: storyMemoryRoute({
    preferred_provider: 'mistral',
    route_objective: 'latency',
    price_tolerance_pct: 1000,
  }),
  firstOutputTimeoutMs: 6000,
  prompt: 'private-prompt',
  temperature: 0.3,
};

function sse(events: unknown[], done = true): string {
  return (
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
    (done ? 'data: [DONE]\n\n' : '')
  );
}

function streamed(
  content: string[],
  options: {
    finish?: string;
    usage?: unknown;
    reasoning?: string[];
    done?: boolean;
    headers?: Record<string, string>;
  } = {}
) {
  const events: unknown[] = [
    ...(options.reasoning ?? []).map((text) => ({ choices: [{ delta: { reasoning: text } }] })),
    ...content.map((text) => ({ choices: [{ delta: { content: text } }] })),
    { choices: [{ delta: {}, finish_reason: options.finish ?? 'stop' }], usage: options.usage },
  ];
  return new Response(sse(events, options.done ?? true), {
    headers: { 'content-type': 'text/event-stream', ...options.headers },
  });
}

/** A body that never sends anything until cancelled. */
function silentBody(onPull?: () => void) {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        onPull?.();
        return new Promise(() => undefined);
      },
    })
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  upstream.forward.mockReset();
  upstream.resolve.mockReset().mockReturnValue({ provider: 'surplus', apiKey: 'private-key' });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('story memory compression on Surplus', () => {
  it('streams the archive, keeps reasoning out of it and reports safe diagnostics', async () => {
    upstream.forward.mockResolvedValue(
      streamed(['```\n😀', ' 字\n```'], {
        reasoning: ['private-thought'],
        usage: { prompt_tokens: 20, completion_tokens: 4 },
        headers: { 'x-si-request-id': 'req_123' },
      })
    );
    const result = await compressStoryMemory(input);
    expect(result.content).toBe('```\n😀 字\n```');
    expect(result).toMatchObject({
      inputTokens: 20,
      outputTokens: 4,
      diagnostics: {
        output_chars: 2,
        reasoning_chars: 'private-thought'.length,
        upstream_status: 200,
        upstream_request_id: 'req_123',
        finish_reason: 'stop',
        max_output_tokens: 24000,
        max_response_bytes: 16 * 1048576,
        timeout_ms: STORY_MEMORY_COMPRESS_TIMEOUT_MS,
        first_output_timeout_ms: 6000,
      },
    });
    expect(result.diagnostics.first_output_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/private|😀/u);
  });

  it('routes like the free-zone fallback: no discount floor, mistral first, latency, wide band', async () => {
    upstream.forward.mockResolvedValue(streamed(['archive']));
    await compressStoryMemory(input);
    const call = upstream.forward.mock.calls[0]![0];
    expect(upstream.resolve).toHaveBeenCalledWith('surplus', 'deepseek-v4.1-flash-1017');
    expect(call.provider).toBe('surplus');
    expect(call.headers).toEqual({
      'X-SI-Route-Objective': 'latency',
      'X-SI-Route-Tolerance-Pct': '1000',
    });
    const body = JSON.parse(call.body);
    expect(body).toMatchObject({
      model: 'deepseek-v4.1-flash-1017',
      stream: true,
      max_tokens: 24000,
      provider_order: ['mistral'],
    });
    // mistral 不收 reasoning 字段，DeepSeek 在 Surplus 上也关不掉思考：不发思考参数。
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('provider');
  });

  it('gives up when nothing (not even reasoning) arrives within the first-output limit', async () => {
    vi.useFakeTimers();
    upstream.forward.mockResolvedValue(silentBody());
    const pending = compressStoryMemory(input).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(6001);
    await expect(pending).resolves.toMatchObject({
      code: 'first_output_timeout',
      diagnostics: { first_output_timeout_ms: 6000 },
    });
  });

  it('counts reasoning as first output, so a slow-thinking reply is not cut off', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    upstream.forward.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
        })
      )
    );
    const pending = compressStoryMemory(input);
    await vi.advanceTimersByTimeAsync(1000);
    controller.enqueue(encoder.encode(sse([{ choices: [{ delta: { reasoning: '想' } }] }], false)));
    await vi.advanceTimersByTimeAsync(10_000);
    controller.enqueue(
      encoder.encode(
        sse([
          { choices: [{ delta: { content: 'archive' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ])
      )
    );
    controller.close();
    await expect(pending).resolves.toMatchObject({ content: 'archive' });
  });

  it.each([401, 403, 404, 429, 500])(
    'does not retry HTTP %s or retain its response body',
    async (status) => {
      upstream.forward.mockResolvedValue(new Response('private-provider-body', { status }));
      const error = await compressStoryMemory(input).catch((err: unknown) => err);
      expect(error).toMatchObject({
        code: `http_${status}`,
        diagnostics: { upstream_status: status },
      });
      expect(error).not.toHaveProperty('diagnostics.output_chars');
      expect(JSON.stringify(error)).not.toContain('private');
      expect(upstream.forward).toHaveBeenCalledTimes(1);
    }
  );

  it('reports token truncation with actual output length but never accepts the archive', async () => {
    upstream.forward.mockResolvedValue(
      streamed(['private-archive'], { finish: 'length', usage: { completion_tokens: 24000 } })
    );
    const error = await compressStoryMemory(input).catch((err: unknown) => err);
    expect(error).toMatchObject({
      code: 'incomplete',
      diagnostics: { finish_reason: 'length', output_chars: 15, output_tokens: 24000 },
    });
    expect(JSON.stringify(error)).not.toContain('private-archive');
  });

  it.each([
    ['without [DONE]', () => streamed(['archive'], { done: false })],
    [
      'with an in-stream error block',
      () =>
        new Response(
          sse([
            { choices: [{ delta: { content: 'archive' } }] },
            { error: { code: 'stream_incomplete', message: 'private' } },
            { choices: [{ delta: {}, finish_reason: 'stop' }] },
          ])
        ),
    ],
  ] as const)('treats a stream %s as incomplete', async (_name, build) => {
    upstream.forward.mockResolvedValue(build());
    await expect(compressStoryMemory(input)).rejects.toMatchObject({ code: 'incomplete' });
  });

  it.each([
    ['empty_response', () => new Response(null)],
    ['response_too_large', () => new Response('x'.repeat(16 * 1048576 + 1))],
  ] as const)('rejects %s', async (code, build) => {
    upstream.forward.mockResolvedValue(build());
    await expect(compressStoryMemory(input)).rejects.toMatchObject({ code });
    expect(upstream.forward).toHaveBeenCalledTimes(1);
  });

  it('terminates a stalled body on caller cancellation even if cleanup never settles', async () => {
    const controller = new AbortController();
    let reading!: () => void;
    const ready = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        reading();
      },
      cancel,
    });
    upstream.forward.mockResolvedValue(new Response(stream));
    const pending = compressStoryMemory({ ...input, signal: controller.signal });
    await ready;
    controller.abort(new DOMException('private-abort', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it('keeps the 120 s total deadline and distinguishes it from the first-output limit', async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    let reading!: () => void;
    const ready = new Promise<void>((resolve) => {
      reading = resolve;
    });
    upstream.forward.mockResolvedValue(silentBody(() => reading()));
    const pending = compressStoryMemory(input);
    await ready;
    timeout.abort(new DOMException('timeout', 'TimeoutError'));
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(120000);
  });

  it('does not dispatch when already cancelled or unconfigured', async () => {
    await expect(
      compressStoryMemory({ ...input, signal: AbortSignal.abort() })
    ).rejects.toMatchObject({ code: 'cancelled' });
    upstream.resolve.mockReturnValue({ apiKey: '' });
    await expect(compressStoryMemory(input)).rejects.toMatchObject({ code: 'unconfigured' });
    expect(upstream.forward).not.toHaveBeenCalled();
  });
});
