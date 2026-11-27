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

function run(
  onRejected = vi.fn(),
  oldMemory: string | null = null,
  onAttempt = vi.fn(),
  maxChars = 200
) {
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
        config: { ...config, memory_max_chars: maxChars },
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

describe('within the limit: the merge is used as-is (no extra shrinking)', () => {
  beforeEach(() => compress.mockReset());

  it('returns on the first valid output without extra calls', async () => {
    compress.mockResolvedValueOnce(reply(archive(2)));
    const { promise, onRejected } = run();
    await expect(promise).resolves.toMatchObject({ content: archive(2) });
    expect(compress).toHaveBeenCalledTimes(1);
    expect(onRejected).not.toHaveBeenCalled();
  });

  it('retries the merge once for structural rejections and stops after two calls', async () => {
    compress.mockResolvedValue(reply(sections[0]!));
    await expect(run().promise).rejects.toMatchObject({ code: 'missing_section' });
    expect(compress).toHaveBeenCalledTimes(2);
    expect(compress.mock.calls[1]![0].prompt as string).toContain('missing_section');
  });
});

describe('over the limit: gentle, ordered, section-by-section shrinking (production prompt v2)', () => {
  beforeEach(() => compress.mockReset());

  // 生产 prompt v2：第一个板块是亲密关系（永不动），主线在第七个。
  const prod = [
    '## 一、亲密关系与进度',
    '## 二、持续状态与规则',
    '## 三、用户偏好（成人向）',
    '## 四、用户的其他要求',
    '## 五、人物档案',
    '## 六、主角现状',
    '## 七、故事主线与约定',
    '## 八、世界观与存疑信息',
  ];
  const promise = '- 甲答应乙三天后回来 (T4)';
  const userLine = '- 甲的随身短剑 (T6·用户)';
  const fill = (size: number, turn: number) => `- ${'事'.repeat(size)} (T${turn})`;
  function prodDoc(parts: Partial<Record<number, string[]>>) {
    return prod
      .map((section, index) => `${section}\n${(parts[index] ?? ['- 字 (T1)']).join('\n')}`)
      .join('\n\n');
  }
  const plot = [fill(40, 1), fill(40, 2), promise, userLine, fill(40, 7)];
  const world = [fill(30, 3), fill(30, 5)];
  const people = [fill(30, 2), fill(30, 8)];
  const intimacy = [fill(60, 2), fill(60, 5)];
  const base = { 0: intimacy, 4: people, 6: plot, 7: world };

  function runProd(maxChars: number) {
    const onAttempt = vi.fn();
    return {
      onAttempt,
      promise: compressChunk({
        ctx: {
          prompt: { template: 'HISTORY={{new_history}} MAX={{max_chars}}', version: 'v2' },
          model: 'm',
          config: { ...config, memory_max_chars: maxChars },
          onRejected: vi.fn(),
          onAttempt,
        },
        sections: prod,
        oldMemory: null,
        promptVars: { new_history: HISTORY },
      }),
    };
  }
  const shrinkPrompts = () => compress.mock.calls.slice(1).map((call) => call[0].prompt as string);

  it('shrinks only the overflow from the 主线 section and stops once within the limit', async () => {
    const long = prodDoc(base);
    const max = countChars(long) - 20;
    const shorter = [fill(20, 1), fill(40, 2), promise, userLine, fill(40, 7)];
    compress.mockResolvedValueOnce(reply(long)).mockResolvedValueOnce(reply(shorter.join('\n')));
    const result = await runProd(max).promise;
    expect(result.content).toBe(prodDoc({ ...base, 6: shorter }));
    expect(compress).toHaveBeenCalledTimes(2);
    const [first] = shrinkPrompts();
    expect(first).toContain('七、故事主线与约定');
    expect(first).not.toContain(intimacy[0]);
    // 只压超出的 20 字：目标 = 原来 − 20（高于六成）。
    const body = countChars(plot.join('\n'));
    expect(first).toContain(`大约 ${body - 20} 字`);
  });

  it('never targets below 60% of a section and moves on to 世界观 then 人物', async () => {
    const long = prodDoc(base);
    const max = countChars(long) - 400;
    const plotBody = countChars(plot.join('\n'));
    const plot60 = [fill(10, 1), fill(10, 2), promise, userLine, fill(40, 7)];
    const world60 = [fill(18, 3), fill(18, 5)];
    const people60 = [fill(18, 2), fill(18, 8)];
    compress
      .mockResolvedValueOnce(reply(long))
      .mockResolvedValueOnce(reply(plot60.join('\n')))
      .mockResolvedValueOnce(reply(world60.join('\n')))
      .mockResolvedValueOnce(reply(people60.join('\n')));
    const { promise: pending, onAttempt } = runProd(max);
    await expect(pending).rejects.toMatchObject({ code: 'too_long' });
    const prompts = shrinkPrompts();
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain(`大约 ${Math.ceil(plotBody * 0.6)} 字`);
    expect(prompts[1]).toContain('八、世界观与存疑信息');
    expect(prompts[2]).toContain('五、人物档案');
    for (const prompt of prompts) {
      expect(prompt).not.toContain('亲密关系');
      expect(prompt).not.toContain('用户偏好');
      expect(prompt).not.toContain('其他要求');
    }
    expect(onAttempt.mock.calls.map(([detail]) => detail.stage)).toEqual([
      'merge',
      'section_shrink',
      'section_shrink',
      'section_shrink',
    ]);
  });

  it('discards a shrink below half of the section or one that drops a protected entry', async () => {
    const long = prodDoc(base);
    const max = countChars(long) - 20;
    const shorterWorld = [fill(10, 3), fill(30, 5)];
    compress
      .mockResolvedValueOnce(reply(long))
      // 少于一半：作废，主线保持原样
      .mockResolvedValueOnce(reply([promise, userLine].join('\n')))
      .mockResolvedValueOnce(reply(shorterWorld.join('\n')));
    const result = await runProd(max).promise;
    expect(result.content).toBe(prodDoc({ ...base, 7: shorterWorld }));

    compress.mockReset();
    compress
      .mockResolvedValueOnce(reply(long))
      // 丢了承诺：作废
      .mockResolvedValueOnce(reply([fill(30, 1), fill(40, 2), userLine, fill(40, 7)].join('\n')))
      .mockResolvedValueOnce(reply(shorterWorld.join('\n')));
    const again = await runProd(max).promise;
    expect(again.content).toContain(promise);
    expect(again.content).toBe(prodDoc({ ...base, 7: shorterWorld }));
  });

  it('fails as too_long without touching protected sections when nothing shrinkable is left', async () => {
    const onlyProtected = prod.filter((section) => /亲密|偏好|要求|状态|主角/.test(section));
    const long = onlyProtected.map((section) => `${section}\n${fill(60, 1)}`).join('\n\n');
    compress.mockResolvedValueOnce(reply(long));
    const pending = compressChunk({
      ctx: {
        prompt: { template: 'HISTORY={{new_history}}', version: 'v2' },
        model: 'm',
        config: { ...config, memory_max_chars: 100 },
        onRejected: vi.fn(),
        onAttempt: vi.fn(),
      },
      sections: onlyProtected,
      oldMemory: null,
      promptVars: { new_history: HISTORY },
    });
    await expect(pending).rejects.toMatchObject({ code: 'too_long' });
    expect(compress).toHaveBeenCalledTimes(1);
  });
});

describe('compression diagnostics and recovery boundaries', () => {
  beforeEach(() => compress.mockReset());

  it('records sizes (not content) for the merge rejection and the section shrink', async () => {
    const long = doc(LONG_PLOT);
    const max = countChars(long) - 10;
    compress
      .mockResolvedValueOnce(reply(long))
      .mockResolvedValueOnce(reply([plotLine(1, 30), plotLine(2, 40), plotLine(3, 40)].join('\n')));
    const { promise, onRejected, onAttempt } = run(vi.fn(), null, vi.fn(), max);
    await promise;
    expect(onRejected).toHaveBeenCalledWith(
      'too_long',
      expect.objectContaining({ attempt: 1, validation_max_chars: max, stage: 'merge' })
    );
    expect(onRejected.mock.calls[0]![1].history_chars).toBeGreaterThan(0);
    const body = countChars(LONG_PLOT.join('\n'));
    expect(onAttempt.mock.calls[1]![0]).toMatchObject({
      stage: 'section_shrink',
      history_chars: 0,
      recent_chars: 0,
      old_memory_chars: body,
      target_chars: body - 10,
    });
  });

  it('does not turn monitoring failure into another generation or rejected archive', async () => {
    const long = doc(LONG_PLOT);
    const max = countChars(long) - 10;
    const shorter = [plotLine(1, 30), plotLine(2, 40), plotLine(3, 40)];
    compress.mockResolvedValueOnce(reply(long)).mockResolvedValueOnce(reply(shorter.join('\n')));
    const broken = () => {
      throw new Error('monitor unavailable');
    };
    const { promise } = run(vi.fn(broken), null, vi.fn(broken), max);
    await expect(promise).resolves.toMatchObject({ content: doc(shorter) });
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
