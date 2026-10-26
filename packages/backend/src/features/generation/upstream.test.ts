import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createSseTap, resolveUpstreamUrl, type SseTapResult } from './upstream.js';
import { MAX_CONVERSATION_REASONING_LENGTH } from '@miniapp/shared';

/** 把若干 chunk 灌进 tap，返回透传出去的字节与终态。 */
async function runTap(
  chunks: Array<string | Buffer>,
  options: {
    generationId?: string | null;
    onDelta?: (delta: string) => void;
    onReasoningDelta?: (delta: string) => void;
  } = {}
): Promise<{ forwarded: string; result: SseTapResult }> {
  let result: SseTapResult | null = null;
  const tap = createSseTap({
    generationId: options.generationId ?? null,
    onDelta: options.onDelta,
    onReasoningDelta: options.onReasoningDelta,
    onEnd: (tapped) => {
      result = tapped;
    },
  });

  const forwarded: Buffer[] = [];
  await pipeline(Readable.from(chunks), tap, async (source) => {
    for await (const chunk of source) forwarded.push(Buffer.from(chunk as Buffer));
  });

  if (!result) throw new Error('onEnd 未被调用');
  return { forwarded: Buffer.concat(forwarded).toString(), result };
}

function sseChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const DELTA = (content: string) => sseChunk({ choices: [{ delta: { content } }] });

const DELTA_A = sseChunk({ id: 'gen-1', choices: [{ delta: { content: '你好' } }] });
const DELTA_B = sseChunk({ id: 'gen-1', choices: [{ delta: { content: '，世界' } }] });
const FINISH = sseChunk({ id: 'gen-1', choices: [{ delta: {}, finish_reason: 'stop' }] });

describe('createSseTap', () => {
  it('原样透传每个字节，不改写响应体', async () => {
    const raw = `${DELTA_A}${DELTA_B}${FINISH}data: [DONE]\n\n`;
    const { forwarded } = await runTap([raw.slice(0, 30), raw.slice(30)]);
    expect(forwarded).toBe(raw);
  });

  it('见到 data: [DONE] 才算正常收流', async () => {
    const done = await runTap([DELTA_A, 'data: [DONE]\n\n']);
    expect(done.result.completed).toBe(true);

    const interrupted = await runTap([DELTA_A, DELTA_B]);
    expect(interrupted.result.completed).toBe(false);
    expect(interrupted.result.content).toBe('你好，世界');
  });

  it('[DONE] 落在最后一个不完整行里时由 flush 兜住', async () => {
    const { result } = await runTap([DELTA_A, 'data: [DONE]']);
    expect(result.completed).toBe(true);
    expect(result.content).toBe('你好');
  });

  it('delta 被 chunk 边界劈开也能完整还原', async () => {
    const raw = `${DELTA_A}${DELTA_B}data: [DONE]\n\n`;
    const splitPoints = [1, 7, 20, 41, raw.length - 3];
    for (const point of splitPoints) {
      const { result } = await runTap([raw.slice(0, point), raw.slice(point)]);
      expect(result.content).toBe('你好，世界');
      expect(result.completed).toBe(true);
    }
  });

  it('从流里抓 generation id，响应头已给出时不覆盖', async () => {
    const fromStream = await runTap([DELTA_A, 'data: [DONE]\n\n']);
    expect(fromStream.result.generationId).toBe('gen-1');

    const fromHeader = await runTap([DELTA_A, 'data: [DONE]\n\n'], { generationId: 'header-id' });
    expect(fromHeader.result.generationId).toBe('header-id');
  });

  it('记录 finish_reason', async () => {
    const { result } = await runTap([DELTA_A, FINISH, 'data: [DONE]\n\n']);
    expect(result.finishReason).toBe('stop');
  });

  it('解析终态 usage 并只保留无正文响应元数据', async () => {
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 5 },
    };
    const terminal = sseChunk({
      id: 'gen-1',
      model: 'venice-model',
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage,
    });

    const { result } = await runTap([DELTA_A, terminal, 'data: [DONE]\n\n']);

    expect(result.usage).toEqual(usage);
    expect(result.responseMetadata).toEqual({ id: 'gen-1', model: 'venice-model', usage });
    expect(result.responseMetadata).not.toHaveProperty('choices');
  });

  it('deltaCount 区分「没有 delta」和「delta 全是空串」', async () => {
    const empty = await runTap([sseChunk({ choices: [{ delta: { content: '' } }] })]);
    expect(empty.result.content).toBe('');
    expect(empty.result.deltaCount).toBe(1);

    const none = await runTap([sseChunk({ choices: [{ delta: {} }] })]);
    expect(none.result.deltaCount).toBe(0);
  });

  it('非 JSON 与非 data 行直接跳过，不打断累积', async () => {
    const { result } = await runTap([
      ': openrouter keep-alive\n\n',
      'data: not-json\n\n',
      DELTA_A,
      'event: ping\n\n',
      'data: [DONE]\n\n',
    ]);
    expect(result.content).toBe('你好');
    expect(result.completed).toBe(true);
  });

  it('onDelta 按到达顺序逐条回调，供自研链路重新编码', async () => {
    const onDelta = vi.fn();
    await runTap([DELTA_A, DELTA_B, 'data: [DONE]\n\n'], { onDelta });
    expect(onDelta.mock.calls.map((call) => call[0])).toEqual(['你好', '，世界']);
  });

  it('separates provider reasoning, prefers plain text over duplicate details, ignores encrypted data', async () => {
    const onReasoningDelta = vi.fn();
    const { result } = await runTap(
      [
        sseChunk({
          choices: [
            {
              delta: {
                reasoning: '先考虑场景',
                reasoning_details: [{ type: 'reasoning.text', text: '先考虑场景' }],
              },
            },
          ],
        }),
        sseChunk({ choices: [{ delta: { reasoning_content: '再保持人设' } }] }),
        sseChunk({
          choices: [{ delta: { reasoning_content: ' [Some reasoning content is encrypted] ' } }],
        }),
        sseChunk({
          choices: [
            {
              delta: {
                reasoning_details: [
                  { type: 'reasoning.text', text: '分析' },
                  { type: 'reasoning.summary', summary: '摘要' },
                  { type: 'reasoning.encrypted', data: 'secret', signature: 'opaque' },
                ],
              },
            },
          ],
        }),
        DELTA_A,
        'data: [DONE]\n\n',
      ],
      { onReasoningDelta }
    );
    expect(onReasoningDelta.mock.calls.map(([text]) => text)).toEqual([
      '先考虑场景',
      '再保持人设',
      '分析摘要',
    ]);
    expect(result).toMatchObject({ content: '你好', deltaCount: 1 });
    expect(JSON.stringify(result)).not.toContain('先考虑场景');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('keeps reasoning before answer when both arrive in one frame and ignores malformed fields', async () => {
    const order: string[] = [];
    const { result } = await runTap(
      [
        sseChunk({ choices: [{ delta: { reasoning_content: '思考', content: '正文' } }] }),
        sseChunk({
          choices: [
            {
              delta: {
                reasoning: {},
                reasoning_details: [null, { type: 'reasoning.text', text: 1 }],
              },
            },
          ],
        }),
        'data: [DONE]\n\n',
        DELTA_B,
      ],
      {
        onReasoningDelta: (text) => order.push(`reasoning:${text}`),
        onDelta: (text) => order.push(`answer:${text}`),
      }
    );
    expect(order).toEqual(['reasoning:思考', 'answer:正文']);
    expect(result.content).toBe('正文');
  });

  it('does not consume an incomplete trailing frame after the terminal marker', async () => {
    const onReasoningDelta = vi.fn();
    const { result } = await runTap(
      [
        DELTA_A,
        'data:[DONE]\n\n',
        sseChunk({
          choices: [{ delta: { reasoning: 'late thought', content: 'late answer' } }],
        }).trimEnd(),
      ],
      { onReasoningDelta }
    );
    expect(result).toMatchObject({ content: '你好', completed: true });
    expect(onReasoningDelta).not.toHaveBeenCalled();
  });

  it('caps forwarded reasoning while continuing to drain answer and usage', async () => {
    const reasoning: string[] = [];
    const { result } = await runTap(
      [
        sseChunk({
          choices: [{ delta: { reasoning: 'a'.repeat(MAX_CONVERSATION_REASONING_LENGTH - 1) } }],
        }),
        sseChunk({ choices: [{ delta: { reasoning: '结尾超额' } }] }),
        DELTA_A,
        sseChunk({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { completion_tokens: 99 },
        }),
        'data: [DONE]\n\n',
      ],
      { onReasoningDelta: (text) => reasoning.push(text) }
    );
    expect(reasoning.join('')).toHaveLength(MAX_CONVERSATION_REASONING_LENGTH);
    expect(result).toMatchObject({
      content: '你好',
      completed: true,
      usage: { completion_tokens: 99 },
    });
  });

  it('reasoning-only output never becomes visible reply content or a content delta', async () => {
    const { result } = await runTap([
      sseChunk({ choices: [{ delta: { reasoning_content: '还在思考' } }] }),
      'data: [DONE]\n\n',
    ]);
    expect(result).toMatchObject({ content: '', deltaCount: 0, completed: true });
  });

  it('prefers structured reasoning over duplicate legacy reasoning across chunk boundaries', async () => {
    const reasoning: string[] = [];
    const { result } = await runTap(
      [
        sseChunk({ choices: [{ delta: { reasoning: 'ABC', content: '<think>A' } }] }),
        DELTA('BC</think>正文'),
        'data: [DONE]\n\n',
      ],
      { onReasoningDelta: (text) => reasoning.push(text) }
    );
    expect(reasoning.join('')).toBe('ABC');
    expect(result.content).toBe('正文');
  });

  it('splits only the leading think region across arbitrary protocol and UTF8 byte boundaries', async () => {
    const payload = Buffer.from(
      [
        sseChunk({ choices: [{ delta: { content: ' \n<thi' } }] }),
        sseChunk({ choices: [{ delta: { content: 'nk>考虑🌙场景</thi' } }] }),
        sseChunk({ choices: [{ delta: { content: 'nk>你好，<think>这个是正文</think>' } }] }),
        'data: [DONE]\n\n',
      ].join('')
    );
    const reasoning: string[] = [];
    const { forwarded, result } = await runTap(
      Array.from(payload, (_byte, index) => payload.subarray(index, index + 1)),
      { onReasoningDelta: (text) => reasoning.push(text) }
    );
    expect(forwarded).toBe(payload.toString());
    expect(reasoning.join('')).toBe('考虑🌙场景');
    expect(result.content).toBe('你好，<think>这个是正文</think>');
  });

  it('preserves literal tags in ordinary roleplay and separates unclosed leading thinking', async () => {
    const literal = await runTap([DELTA('她说：<think>这是角色台词</think>'), 'data: [DONE]\n\n']);
    expect(literal.result.content).toBe('她说：<think>这是角色台词</think>');
    const thinking: string[] = [];
    const unclosed = await runTap([DELTA('<think>未完成思考</thi')], {
      onReasoningDelta: (text) => thinking.push(text),
    });
    expect(unclosed.result).toMatchObject({ content: '', deltaCount: 0, completed: false });
    expect(thinking.join('')).toBe('未完成思考</thi');
  });

  it('流被销毁导致 flush 不触发时，snapshot 仍能取到已累积的内容', async () => {
    const tap = createSseTap({ onEnd: () => undefined });
    await new Promise<void>((resolve, reject) =>
      tap.write(Buffer.from(DELTA_A), (err) => (err ? reject(err) : resolve()))
    );
    tap.read();
    expect(tap.snapshot()).toMatchObject({ completed: false, content: '你好', deltaCount: 1 });
  });
});

describe('resolveUpstreamUrl', () => {
  it('拼在 LLM_UPSTREAM_URL 之后', () => {
    expect(resolveUpstreamUrl('/chat/completions')).toMatch(/\/chat\/completions$/);
  });
});

describe('durable call identity before streaming', () => {
  it('persists the first ID before either reasoning or visible answer is forwarded', async () => {
    const events: string[] = [];
    let unblock!: () => void;
    const pending = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const tap = createSseTap({
      onGenerationId: async () => {
        events.push('persist');
        await pending;
      },
      onReasoningDelta: (text) => events.push(`reasoning:${text}`),
      onDelta: (text) => events.push(`answer:${text}`),
      onEnd: () => undefined,
    });
    const stream = pipeline(
      Readable.from([
        sseChunk({ id: 'gen-1', choices: [{ delta: { reasoning: '思考', content: '正文' } }] }),
        'data: [DONE]\n\n',
      ]),
      tap,
      async (source) => {
        for await (const _chunk of source) {
          /* drain */
        }
      }
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(['persist']);
    unblock();
    await stream;
    expect(events).toEqual(['persist', 'reasoning:思考', 'answer:正文']);
  });
  it('awaits ID persistence before the first delta, once per response', async () => {
    const events: string[] = [];
    let unblock!: () => void;
    const pending = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const tap = createSseTap({
      onGenerationId: async () => {
        events.push('persist');
        await pending;
      },
      onDelta: (text) => events.push(text),
      onEnd: () => undefined,
    });
    const stream = pipeline(
      Readable.from([DELTA_A, DELTA_B, 'data: [DONE]\n\n']),
      tap,
      async (source) => {
        for await (const _chunk of source) {
          /* drain */
        }
      }
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(['persist']);
    unblock();
    await stream;
    expect(events).toEqual(['persist', '你好', '，世界']);
  });

  it('does not swallow a persistence failure or lose earlier observed reply text', async () => {
    const first = sseChunk({ choices: [{ delta: { content: 'already delivered' } }] });
    const delta = vi.fn();
    const tap = createSseTap({
      onGenerationId: async () => {
        throw new Error('ID storage failed');
      },
      onDelta: delta,
      onEnd: vi.fn(),
    });
    await expect(
      pipeline(Readable.from([first, DELTA_A]), tap, async (source) => {
        for await (const _chunk of source) {
          /* drain */
        }
      })
    ).rejects.toThrow('ID storage failed');
    expect(tap.snapshot()).toMatchObject({ content: 'already delivered你好', completed: false });
    expect(delta).toHaveBeenCalledExactlyOnceWith('already delivered');
  });

  it('does not forward reasoning or held prefixes after destruction while awaiting provider identity', async () => {
    const emitted = vi.fn();
    let unblock!: () => void;
    const pending = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const tap = createSseTap({
      onGenerationId: () => pending,
      onReasoningDelta: emitted,
      onDelta: emitted,
      onEnd: () => undefined,
    });
    const stream = pipeline(
      Readable.from([
        sseChunk({
          id: 'gen-1',
          choices: [{ delta: { reasoning_content: 'thought', content: '<thi' } }],
        }),
        'data: [DONE]\n\n',
      ]),
      tap,
      async (source) => {
        for await (const _chunk of source) {
          /* drain */
        }
      }
    );
    const rejected = expect(stream).rejects.toThrow('cancelled test');
    await new Promise<void>((resolve) => setImmediate(resolve));
    tap.destroy(new Error('cancelled test'));
    unblock();
    await rejected;
    expect(emitted).not.toHaveBeenCalled();
    expect(tap.snapshot().content).toBe('');
  });
});
