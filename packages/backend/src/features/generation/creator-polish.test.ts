import { describe, expect, it, vi } from 'vitest';
import { CreatorPolishRequestSchema, emptyCharacterDraft } from '@miniapp/shared';

const transport = vi.hoisted(() => ({ forward: vi.fn() }));
vi.mock('./upstream.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./upstream.js')>();
  return {
    ...original,
    forwardToUpstream: transport.forward,
    resolveProviderUpstream: () => ({
      provider: 'openrouter',
      url: 'https://example.invalid/stream',
      apiKey: 'test-only',
    }),
  };
});
import { streamCreatorPolish } from './creator-polish.js';
import { buildPolishMessages } from './creator-polish-prompts.js';

const input = {
  target: 'opening' as const,
  draft: {
    ...emptyCharacterDraft(),
    name: '林舟',
    backgroundFiles: [{ id: 'file1', name: '背景.txt', content: '完整参考资料：经营书店' }],
  },
};
function sse(content: string, finish: string, done = true) {
  const bytes = new TextEncoder().encode(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n${done ? 'data: [DONE]\n\n' : ''}`
  );
  // Deliberately split inside UTF-8 characters, not only complete JSON chunks.
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let n = 0; n < bytes.length; n += 7) controller.enqueue(bytes.slice(n, n + 7));
        controller.close();
      },
    })
  );
}

describe('creator polish transport and contracts', () => {
  it('keeps the selected model, all attachments, and returns decoded visible text', async () => {
    transport.forward.mockResolvedValueOnce(sse('一盏灯，照着归来的人。', 'stop'));
    const events: unknown[] = [];
    const result = await streamCreatorPolish(input, new AbortController().signal, (event) =>
      events.push(event)
    );
    expect(result).toEqual({ completed: true, characters: '一盏灯，照着归来的人。'.length });
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(
      events
        .filter(
          (event): event is { type: 'delta'; text: string } =>
            (event as { type: string }).type === 'delta'
        )
        .map((event) => event.text)
        .join('')
    ).toBe('一盏灯，照着归来的人。');
    const request = JSON.parse(transport.forward.mock.calls.at(-1)![0].body);
    expect(request.model).toBe('google/gemini-4-argon');
    expect(request.messages[1].content).toContain('完整参考资料：经营书店');
  });
  it.each([
    ['length', true],
    ['stop', false],
  ])('preserves partial output with %s / done=%s', async (finish, done) => {
    transport.forward.mockResolvedValueOnce(
      sse('已经生成的部分', finish as string, done as boolean)
    );
    const events: unknown[] = [];
    const result = await streamCreatorPolish(input, new AbortController().signal, (event) =>
      events.push(event)
    );
    expect(result.completed).toBe(false);
    expect(events).toContainEqual({ type: 'delta', text: '已经生成的部分' });
    expect(events.at(-1)).toMatchObject({ type: 'error' });
  });
  it('uses separate module instructions and rejects empty input or preset polishing', () => {
    expect(
      CreatorPolishRequestSchema.safeParse({ target: 'preset', draft: input.draft }).success
    ).toBe(false);
    expect(
      CreatorPolishRequestSchema.safeParse({ target: 'opening', draft: emptyCharacterDraft() })
        .success
    ).toBe(false);
    expect(buildPolishMessages('opening', input.draft).system).toContain('400—600字');
    expect(buildPolishMessages('background', input.draft).system).toContain('至少2500字');
    expect(buildPolishMessages('background', input.draft).prompt).toContain(
      '完整参考资料：经营书店'
    );
  });
});

it('includes selected server-side preset context without requiring client rule text', async () => {
  transport.forward.mockResolvedValue(sse('新的开场内容', 'stop'));
  await streamCreatorPolish(
    { ...input, draft: { ...input.draft, selectedPresetIds: ['world-causality'] } },
    new AbortController().signal,
    () => undefined
  );
  const body = JSON.parse(transport.forward.mock.calls.at(-1)![0].body);
  expect(body.messages[1].content).toContain('鲜活世界的原则');
  expect(body.messages[1].content).toContain('完整参考资料：经营书店');
});
