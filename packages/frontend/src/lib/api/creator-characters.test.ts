import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyCharacterDraft } from '@miniapp/shared';
import { streamCreatorPolish } from './creator-characters';

vi.mock('@/lib/telegram/auth', () => ({
  getRawInitData: () => undefined,
  INIT_DATA_HEADER: 'X-Init-Data',
}));

afterEach(() => vi.unstubAllGlobals());

function response(chunks: Uint8Array[]) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/x-ndjson' } }
  );
}

function options() {
  const texts: string[] = [];
  return {
    texts,
    input: {
      body: { target: 'opening' as const, draft: { ...emptyCharacterDraft(), name: '灯塔守夜人' } },
      signal: new AbortController().signal,
      onText: (text: string) => texts.push(text),
    },
  };
}

describe('creator polish streaming', () => {
  it('decodes lines and multibyte characters split across arbitrary chunks', async () => {
    const encoded = new TextEncoder().encode(
      `${JSON.stringify({ type: 'delta', text: '海风' })}\n${JSON.stringify({ type: 'delta', text: '吹过灯塔。' })}\n${JSON.stringify({ type: 'done' })}\n`
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response(Array.from(encoded, (byte) => Uint8Array.of(byte))))
    );
    const { input, texts } = options();
    await expect(streamCreatorPolish(input)).resolves.toBe('海风吹过灯塔。');
    expect(texts).toEqual(['海风', '海风吹过灯塔。']);
  });

  it('keeps received text when the model reports truncation', async () => {
    const raw = `${JSON.stringify({ type: 'delta', text: '留下来的半段内容' })}\n${JSON.stringify({ type: 'error', message: '未完整完成，可采用已有内容' })}\n`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([new TextEncoder().encode(raw)])));
    const { input, texts } = options();
    await expect(streamCreatorPolish(input)).rejects.toThrow('未完整完成');
    expect(texts.at(-1)).toBe('留下来的半段内容');
  });

  it('does not mark an interrupted stream complete when its terminal event is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          response([new TextEncoder().encode(JSON.stringify({ type: 'delta', text: '仍可采用' }))])
        )
    );
    const { input, texts } = options();
    await expect(streamCreatorPolish(input)).rejects.toThrow('未完整完成');
    expect(texts).toEqual(['仍可采用']);
  });

  it('rejects an empty draft before making a model request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { input } = options();
    await expect(
      streamCreatorPolish({
        ...input,
        body: { target: 'background', draft: emptyCharacterDraft() },
      })
    ).rejects.toThrow('先写几句想法');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
