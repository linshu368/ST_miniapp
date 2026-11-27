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
vi.mock('../conversations/turn-repositories.js', () => ({
  characters: () => ({ requireCard: async () => ({ name: 'character' }) }),
  userSettings: () => ({ getDisplayName: async () => 'user' }),
}));

import { compressChunk, runStoryMemoryJob, StoryMemoryJobError } from './compress-job.js';
import type { StoryMemoryRepository } from '../../infrastructure/repositories/StoryMemoryRepository.js';
import { countChars, memoryTargetChars } from './text.js';

const sections = extractStoryMemorySections(DEFAULT_STORY_MEMORY_PROMPT);
const config = { ...DEFAULT_STORY_MEMORY_CONFIG, memory_max_chars: 200 };
const archive = (filler: number) =>
  sections.map((section) => `${section}\n- ${'字'.repeat(filler)}`).join('\n\n');
const HISTORY = '这是本块很长的新历史原文。';

function run(onRejected = vi.fn(), oldMemory: string | null = null, onAttempt = vi.fn()) {
  return {
    onRejected,
    onAttempt,
    promise: compressChunk({
      ctx: {
        prompt: {
          template: 'HISTORY={{new_history}} MAX={{max_chars}} OLD={{old_memory}}',
          version: 'v1',
        },
        model: 'm',
        config,
        onRejected,
        onAttempt,
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

const [lead, ...others] = sections;
/** 第一个板块是带 T 编号的剧情条目，其余板块各一条 */
function doc(plot: string[], filler = 2) {
  return [
    `${lead}\n${plot.join('\n')}`,
    ...others.map((section) => `${section}\n- ${'字'.repeat(filler)}`),
  ].join('\n\n');
}
const plotLine = (turn: number, size: number) => `- ${'事'.repeat(size)} (T${turn})`;
const LONG_PLOT = [plotLine(1, 40), plotLine(2, 40), plotLine(3, 40)];

describe('compressChunk over-length handling', () => {
  beforeEach(() => compress.mockReset());

  it('returns on the first valid output without extra calls', async () => {
    compress.mockResolvedValueOnce(reply(archive(2)));
    const { promise, onRejected } = run();
    await expect(promise).resolves.toMatchObject({ content: archive(2) });
    expect(compress).toHaveBeenCalledTimes(1);
    expect(onRejected).not.toHaveBeenCalled();
  });

  it('shrinks only the lead section of a too-long merge and splices it back', async () => {
    const long = doc(LONG_PLOT);
    expect(countChars(long)).toBeGreaterThan(200);
    compress
      .mockResolvedValueOnce(reply(long))
      .mockResolvedValueOnce(reply('- 早期事件合并 (T1-T3)'));
    const { promise, onAttempt } = run();
    const result = await promise;
    expect(result.content).toBe(doc(['- 早期事件合并 (T1-T3)']));
    expect(compress).toHaveBeenCalledTimes(2);
    const second = compress.mock.calls[1]![0].prompt as string;
    expect(second).toContain('【板块原文】');
    expect(second).toContain(LONG_PLOT.join('\n'));
    expect(second).not.toContain(HISTORY);
    for (const section of others) expect(second).not.toContain(section);
    expect(onAttempt.mock.calls.map(([detail]) => [detail.stage, detail.outcome])).toEqual([
      ['merge', 'rejected'],
      ['section_shrink', 'succeeded'],
    ]);
  });

  it('drops the oldest lead-section entries when the section shrink is still too long', async () => {
    const long = doc(LONG_PLOT);
    compress.mockResolvedValueOnce(reply(long)).mockResolvedValueOnce(reply(LONG_PLOT.join('\n')));
    const { promise, onAttempt } = run();
    const result = await promise;
    expect(result.content).toBe(doc([plotLine(2, 40), plotLine(3, 40)]));
    expect(result).toMatchObject({ inputTokens: 1, outputTokens: 1 });
    expect(compress).toHaveBeenCalledTimes(2);
    const trim = onAttempt.mock.calls.at(-1)![0];
    expect(trim).toMatchObject({ stage: 'trim', outcome: 'succeeded', trimmed_line_count: 1 });
    expect(trim.output_chars).toBeLessThanOrEqual(200);
  });

  it('trims from the merge output when the section shrink rewrites other sections', async () => {
    const long = doc(LONG_PLOT);
    compress
      .mockResolvedValueOnce(reply(long))
      .mockResolvedValueOnce(reply(`- 合并 (T1-T3)\n${others[0]}\n- 改写`));
    const result = await run().promise;
    expect(result.content).toBe(doc([plotLine(2, 40), plotLine(3, 40)]));
  });

  it('fails as too_long without extra calls when the other sections alone exceed the limit', async () => {
    compress.mockResolvedValueOnce(reply(doc(LONG_PLOT, 40)));
    const { promise, onAttempt } = run();
    await expect(promise).rejects.toMatchObject({ code: 'too_long' });
    expect(promise).rejects.toBeInstanceOf(StoryMemoryJobError);
    expect(compress).toHaveBeenCalledTimes(1);
    expect(onAttempt.mock.calls.at(-1)![0]).toMatchObject({ stage: 'trim', outcome: 'rejected' });
  });

  it('retries the merge once for other rejection reasons and trims a too-long retry directly', async () => {
    compress
      .mockResolvedValueOnce(reply(sections[0]!))
      .mockResolvedValueOnce(reply(doc(LONG_PLOT)));
    const result = await run().promise;
    expect(result.content).toBe(doc([plotLine(2, 40), plotLine(3, 40)]));
    expect(compress).toHaveBeenCalledTimes(2);
    expect(compress.mock.calls[1]![0].prompt as string).toContain('missing_section');
    for (const call of compress.mock.calls) {
      expect(call[0].prompt as string).not.toContain('【板块原文】');
    }
  });

  it('stops after two calls when both merges are structurally invalid', async () => {
    compress.mockResolvedValue(reply(sections[0]!));
    await expect(run().promise).rejects.toMatchObject({ code: 'missing_section' });
    expect(compress).toHaveBeenCalledTimes(2);
  });
});

describe('compression diagnostics and recovery boundaries', () => {
  beforeEach(() => compress.mockReset());

  it('records sizes (not content) for the merge rejection and the section shrink', async () => {
    compress
      .mockResolvedValueOnce(reply(doc(LONG_PLOT)))
      .mockResolvedValueOnce(reply('- 合并 (T1-T3)'));
    const { promise, onRejected, onAttempt } = run();
    await promise;
    expect(onRejected).toHaveBeenCalledWith(
      'too_long',
      expect.objectContaining({ attempt: 1, validation_max_chars: 200, stage: 'merge' })
    );
    expect(onRejected.mock.calls[0]![1].output_chars).toBeGreaterThan(200);
    expect(onRejected.mock.calls[0]![1].history_chars).toBeGreaterThan(0);
    const total = countChars(doc(LONG_PLOT));
    const body = countChars(LONG_PLOT.join('\n'));
    expect(onAttempt.mock.calls[1]![0]).toMatchObject({
      stage: 'section_shrink',
      history_chars: 0,
      recent_chars: 0,
      old_memory_chars: body,
      target_chars: Math.min(Math.floor(body / 2), body - (total - memoryTargetChars(200))),
    });
  });

  it('does not turn monitoring failure into another generation or rejected archive', async () => {
    compress
      .mockResolvedValueOnce(reply(doc(LONG_PLOT)))
      .mockResolvedValueOnce(reply('- 合并 (T1-T3)'));
    const broken = () => {
      throw new Error('monitor unavailable');
    };
    const { promise } = run(vi.fn(broken), null, vi.fn(broken));
    await expect(promise).resolves.toMatchObject({ content: doc(['- 合并 (T1-T3)']) });
    expect(compress).toHaveBeenCalledTimes(2);
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

  it('merges straight into an old memory above the target line (no pre-shrink call)', async () => {
    const oldMemory = archive(30);
    expect(countChars(oldMemory)).toBeGreaterThan(memoryTargetChars(200));
    compress.mockResolvedValueOnce(reply(archive(12)));
    await expect(run(vi.fn(), oldMemory).promise).resolves.toMatchObject({ content: archive(12) });
    expect(compress).toHaveBeenCalledTimes(1);
    const first = compress.mock.calls[0]![0].prompt as string;
    expect(first).toContain('HISTORY=' + HISTORY);
    expect(first).toContain('OLD=' + oldMemory);
  });
});

describe('partial archive commits', () => {
  it('reports committed progress on a later failure and resumes from that coverage', async () => {
    compress
      .mockReset()
      .mockResolvedValueOnce(reply(archive(2)))
      .mockRejectedValueOnce(new Error('second chunk failed'));
    const turns = [1, 2].map((turnIndex) => ({
      turnIndex,
      userInput: 'input',
      assistantReply: 'reply',
    }));
    const repository = {
      readTurns: vi.fn().mockResolvedValue(turns),
      readRecentTurns: vi.fn().mockResolvedValue([]),
      commitVersion: vi.fn().mockResolvedValue(1),
    };
    const onProgress = vi.fn();
    const ctx = {
      repository: repository as unknown as StoryMemoryRepository,
      workerId: 'worker',
      leaseSeconds: 900,
      config: { ...config, chunk_chars: 1 },
      model: 'm',
      prompt: { template: DEFAULT_STORY_MEMORY_PROMPT, version: 'v1' },
      onRejected: vi.fn(),
      onProgress,
    };
    const job = {
      sessionId: 'session',
      userId: 'user',
      characterId: 'character',
      windowStart: 1,
      targetEnd: 2,
      attempts: 0,
      coveredEndTurn: 0,
      memoryContent: null,
    };
    await expect(runStoryMemoryJob(job, ctx)).rejects.toThrow('second chunk failed');
    expect(repository.commitVersion).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ chunks: 1, rangeEnd: 1 }));

    repository.readTurns.mockResolvedValue([turns[1]!]);
    compress.mockResolvedValueOnce(reply(archive(3)));
    const resumed = await runStoryMemoryJob(
      { ...job, coveredEndTurn: 1, memoryContent: archive(2) },
      ctx
    );
    expect(repository.readTurns).toHaveBeenLastCalledWith(expect.objectContaining({ fromTurn: 2 }));
    expect(repository.commitVersion).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedCoveredEnd: 1,
        coveredEnd: 2,
      })
    );
    expect(resumed).toMatchObject({ rangeStart: 2, rangeEnd: 2, chunks: 1 });
  });
});
