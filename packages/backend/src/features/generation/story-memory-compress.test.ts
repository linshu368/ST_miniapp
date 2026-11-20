import { beforeEach, describe, expect, it, vi } from 'vitest';

const upstream = vi.hoisted(() => ({ forward: vi.fn(), resolve: vi.fn() }));
vi.mock('./upstream.js', () => ({
  forwardToUpstream: upstream.forward,
  resolveProviderUpstream: upstream.resolve,
}));
import { compressStoryMemory, STORY_MEMORY_COMPRESS_TIMEOUT_MS } from './story-memory-compress.js';

const input = {
  model: 'model',
  preferredProviders: [],
  prompt: 'private-prompt',
  temperature: 0.3,
};
function response(content = '## A\n😀 字', finish = 'stop', usage: unknown = undefined) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: finish }],
      usage,
    })
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  upstream.forward.mockReset();
  upstream.resolve.mockReset().mockReturnValue({ provider: 'openrouter', apiKey: 'private-key' });
});

describe('story memory transport diagnostics', () => {
  it('retains measured Unicode lengths, usage and actual bounded request settings', async () => {
    upstream.forward.mockResolvedValue(
      response('```\n😀 字\n```', 'stop', {
        prompt_tokens: 20,
        completion_tokens: 4,
      })
    );
    const result = await compressStoryMemory(input);
    expect(result).toMatchObject({
      inputTokens: 20,
      outputTokens: 4,
      diagnostics: {
        output_chars: 2,
        input_tokens: 20,
        output_tokens: 4,
        upstream_status: 200,
        finish_reason: 'stop',
        max_output_tokens: 12000,
        max_response_bytes: 262144,
        timeout_ms: STORY_MEMORY_COMPRESS_TIMEOUT_MS,
      },
    });
    expect(result.diagnostics.response_bytes).toBeGreaterThan(0);
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/private|😀/u);
    expect(JSON.parse(upstream.forward.mock.calls[0]![0].body)).toMatchObject({
      stream: false,
      max_tokens: 12000,
      reasoning: { enabled: false, exclude: true },
    });
  });

  it('omits unknown/invalid usage instead of measuring it as zero', async () => {
    upstream.forward.mockResolvedValue(
      response('archive', 'stop', {
        prompt_tokens: -1,
        completion_tokens: '4',
      })
    );
    const result = await compressStoryMemory(input);
    expect(result.inputTokens).toBeNull();
    expect(result.diagnostics).not.toHaveProperty('input_tokens');
    expect(result.diagnostics).not.toHaveProperty('output_tokens');
  });

  it.each([401, 403, 429, 500])(
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
      response('private-archive', 'length', { completion_tokens: 12000 })
    );
    const error = await compressStoryMemory(input).catch((err: unknown) => err);
    expect(error).toMatchObject({
      code: 'incomplete',
      diagnostics: {
        finish_reason: 'length',
        output_chars: 15,
        output_tokens: 12000,
      },
    });
    expect(JSON.stringify(error)).not.toContain('private-archive');
  });

  it.each([
    ['empty_response', () => new Response(null)],
    ['invalid_response', () => new Response('not-json')],
    ['invalid_response', () => new Response(JSON.stringify({ choices: [] }))],
    ['response_too_large', () => new Response('x'.repeat(262145))],
  ] as const)('rejects %s with safe size diagnostics', async (code, build) => {
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

  it('enforces its own body deadline and distinguishes it from caller cancellation', async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    let reading!: () => void;
    const ready = new Promise<void>((resolve) => {
      reading = resolve;
    });
    upstream.forward.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull() {
            reading();
          },
        })
      )
    );
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
