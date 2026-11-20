import { DEFAULT_STORY_MEMORY_CONFIG, DEFAULT_STORY_MEMORY_PROMPT } from '@miniapp/shared';
import { extractStoryMemorySections } from '@miniapp/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const compress = vi.hoisted(() => vi.fn());
vi.mock('../generation/story-memory-compress.js', () => ({
  compressStoryMemory: compress,
  StoryMemoryCompressError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));

import { compressChunk, StoryMemoryJobError } from './compress-job.js';
import { memoryTargetChars, renderShrinkPrompt } from './text.js';

const sections = extractStoryMemorySections(DEFAULT_STORY_MEMORY_PROMPT);
const config = { ...DEFAULT_STORY_MEMORY_CONFIG, memory_max_chars: 200 };
const archive = (filler: number) =>
  sections.map((section) => `${section}\n- ${'字'.repeat(filler)}`).join('\n\n');
const HISTORY = '这是本块很长的新历史原文。';

function run(onRejected = vi.fn(), oldMemory: string | null = null) {
  return {
    onRejected,
    promise: compressChunk({
      ctx: {
        prompt: {
          template: 'HISTORY={{new_history}} MAX={{max_chars}} OLD={{old_memory}}',
          version: 'v1',
        },
        model: 'm',
        config,
        onRejected,
      },
      sections,
      oldMemory,
      promptVars: { new_history: HISTORY, old_memory: oldMemory ?? '（空）' },
    }),
  };
}

function reply(content: string) {
  return { content, inputTokens: 1, outputTokens: 1 };
}

describe('compressChunk over-length handling', () => {
  beforeEach(() => compress.mockReset());

  it('returns on the first valid output without extra calls', async () => {
    compress.mockResolvedValueOnce(reply(archive(2)));
    const { promise, onRejected } = run();
    await expect(promise).resolves.toMatchObject({ content: archive(2) });
    expect(compress).toHaveBeenCalledTimes(1);
    expect(onRejected).not.toHaveBeenCalled();
  });

  it('retries a too-long output with the actual and max char counts, still on the full prompt', async () => {
    const long = archive(60);
    compress.mockResolvedValueOnce(reply(long)).mockResolvedValueOnce(reply(archive(2)));
    const { promise } = run();
    await promise;
    const second = compress.mock.calls[1]![0].prompt as string;
    expect(second).toContain('HISTORY=' + HISTORY);
    expect(second).toContain('上一次输出超长');
    expect(second).toContain('超过上限 200 字');
  });

  it('shrinks the last too-long output on the third call instead of re-sending the history', async () => {
    const long = archive(60);
    compress
      .mockResolvedValueOnce(reply(long))
      .mockResolvedValueOnce(reply(archive(50)))
      .mockResolvedValueOnce(reply(archive(2)));
    const { promise, onRejected } = run();
    await expect(promise).resolves.toMatchObject({ content: archive(2) });
    expect(compress).toHaveBeenCalledTimes(3);
    const third = compress.mock.calls[2]![0].prompt as string;
    expect(third).toContain('【档案原文】');
    expect(third).toContain(archive(50));
    expect(third).not.toContain(HISTORY);
    // Rejections carry sizes (not content) so "too long by how much" is visible in logs.
    expect(onRejected).toHaveBeenNthCalledWith(
      1,
      'too_long',
      expect.objectContaining({ attempt: 1, maxChars: 200, shrinkPass: false })
    );
    expect(onRejected.mock.calls[0]![1].outputChars).toBeGreaterThan(200);
    expect(onRejected.mock.calls[0]![1].historyChars).toBeGreaterThan(0);
    expect(onRejected).toHaveBeenNthCalledWith(
      2,
      'too_long',
      expect.objectContaining({ attempt: 2, shrinkPass: false })
    );
  });

  it('still rejects when the shrink pass is too long or loses a section', async () => {
    compress.mockResolvedValue(reply(archive(60)));
    const tooLong = run();
    await expect(tooLong.promise).rejects.toMatchObject({ code: 'too_long' });
    expect(tooLong.onRejected).toHaveBeenLastCalledWith(
      'too_long',
      expect.objectContaining({ attempt: 3, shrinkPass: true })
    );

    compress.mockReset();
    compress
      .mockResolvedValueOnce(reply(archive(60)))
      .mockResolvedValueOnce(reply(archive(60)))
      .mockResolvedValueOnce(reply(sections[0]!));
    await expect(run().promise).rejects.toBeInstanceOf(StoryMemoryJobError);
    expect(compress).toHaveBeenCalledTimes(3);
  });

  it('does not use the shrink pass for other rejection reasons', async () => {
    compress
      .mockResolvedValueOnce(reply(sections[0]!))
      .mockResolvedValueOnce(reply(sections[0]!))
      .mockResolvedValueOnce(reply(archive(2)));
    await run().promise;
    for (const call of compress.mock.calls) {
      expect(call[0].prompt as string).not.toContain('【档案原文】');
    }
  });
});

describe('compressChunk headroom', () => {
  beforeEach(() => compress.mockReset());

  it('tells the model a target below the hard limit', async () => {
    compress.mockResolvedValueOnce(reply(archive(2)));
    await run().promise;
    expect(compress.mock.calls[0]![0].prompt as string).toContain(`MAX=${memoryTargetChars(200)} `);
    expect(memoryTargetChars(8000)).toBe(6800);
  });

  it('does not pre-shrink an old memory that is below the target line', async () => {
    compress.mockResolvedValueOnce(reply(archive(2)));
    await run(vi.fn(), archive(2)).promise;
    expect(compress).toHaveBeenCalledTimes(1);
  });

  it('shrinks an old memory above the target line first, then merges into the shrunk one', async () => {
    const oldMemory = archive(30);
    expect(oldMemory.length).toBeGreaterThan(memoryTargetChars(200));
    const shrunk = archive(10);
    compress.mockResolvedValueOnce(reply(shrunk)).mockResolvedValueOnce(reply(archive(12)));
    await expect(run(vi.fn(), oldMemory).promise).resolves.toMatchObject({ content: archive(12) });
    expect(compress).toHaveBeenCalledTimes(2);
    const first = compress.mock.calls[0]![0].prompt as string;
    expect(first).toContain('【档案原文】');
    expect(first).not.toContain(HISTORY);
    const second = compress.mock.calls[1]![0].prompt as string;
    expect(second).toContain('HISTORY=' + HISTORY);
    expect(second).toContain('OLD=' + shrunk);
    expect(second).not.toContain(oldMemory);
  });

  it('falls back to the original old memory when the pre-shrink fails, without failing the job', async () => {
    const oldMemory = archive(30);
    compress
      .mockRejectedValueOnce(new Error('upstream down'))
      .mockResolvedValueOnce(reply(archive(12)));
    await expect(run(vi.fn(), oldMemory).promise).resolves.toMatchObject({ content: archive(12) });
    expect(compress.mock.calls[1]![0].prompt as string).toContain('OLD=' + oldMemory);

    compress.mockReset();
    const onRejected = vi.fn();
    compress.mockResolvedValueOnce(reply(archive(60))).mockResolvedValueOnce(reply(archive(12)));
    await run(onRejected, oldMemory).promise;
    expect(onRejected).toHaveBeenCalledWith(
      'too_long',
      expect.objectContaining({ attempt: 0, shrinkPass: true })
    );
    expect(compress.mock.calls[1]![0].prompt as string).toContain('OLD=' + oldMemory);
  });
});

describe('renderShrinkPrompt', () => {
  it('uses the given target ratio', () => {
    expect(
      renderShrinkPrompt({ memory: archive(60), sections, maxChars: 5000, targetRatio: 0.65 })
    ).toContain('3250 字以内');
  });

  it('states the real size, a target with headroom, the sections and keeps wording rules', () => {
    const prompt = renderShrinkPrompt({ memory: archive(60), sections, maxChars: 5000 });
    expect(prompt).toContain('超过了 5000 字');
    expect(prompt).toContain('4000 字以内');
    for (const section of sections) expect(prompt).toContain(section);
    expect(prompt).toContain('不淡化');
    expect(prompt.endsWith(archive(60))).toBe(true);
  });
});
