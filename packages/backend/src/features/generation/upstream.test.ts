import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createSseTap, resolveUpstreamUrl, type SseTapResult } from './upstream.js';

/** 把若干 chunk 灌进 tap，返回透传出去的字节与终态。 */
async function runTap(
  chunks: string[],
  options: { generationId?: string | null; onDelta?: (delta: string) => void } = {}
): Promise<{ forwarded: string; result: SseTapResult }> {
  let result: SseTapResult | null = null;
  const tap = createSseTap({
    generationId: options.generationId ?? null,
    onDelta: options.onDelta,
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

  it('流被销毁导致 flush 不触发时，snapshot 仍能取到已累积的内容', async () => {
    const tap = createSseTap({ onEnd: () => undefined });
    tap.write(Buffer.from(DELTA_A));
    tap.read();
    expect(tap.snapshot()).toMatchObject({ completed: false, content: '你好', deltaCount: 1 });
  });
});

describe('resolveUpstreamUrl', () => {
  it('拼在 LLM_UPSTREAM_URL 之后', () => {
    expect(resolveUpstreamUrl('/chat/completions')).toMatch(/\/chat\/completions$/);
  });
});
