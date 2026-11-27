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
      nowTurn: 10,
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

describe('length budget and the over-length retry (production prompt v2, 11-27 third version)', () => {
  beforeEach(() => compress.mockReset());

  // 生产 prompt v2：第一个板块是亲密关系（程序守住），主线在第七个。
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
  const fill = (size: number, turn: number) => `- ${'事'.repeat(size)} (T${turn})`;
  function prodDoc(parts: Partial<Record<number, string[]>>) {
    return prod
      .map((section, index) => `${section}\n${(parts[index] ?? ['- 字 (T1)']).join('\n')}`)
      .join('\n\n');
  }
  const intimacy = [fill(150, 2), fill(150, 5)];
  const base = { 0: intimacy, 4: [fill(60, 2)], 6: [fill(80, 1), fill(80, 7)], 7: [fill(40, 3)] };

  function runProd(maxChars: number, oldMemory: string | null, nowTurn = 120) {
    const onAttempt = vi.fn();
    const onRejected = vi.fn();
    return {
      onAttempt,
      onRejected,
      promise: compressChunk({
        ctx: {
          prompt: { template: 'HISTORY={{new_history}} MAX={{max_chars}}', version: 'v2' },
          model: 'm',
          config: { ...config, memory_max_chars: maxChars },
          onRejected,
          onAttempt,
        },
        sections: prod,
        oldMemory,
        nowTurn,
        promptVars: { new_history: '新'.repeat(2000) },
      }),
    };
  }
  const prompts = () => compress.mock.calls.map((call) => call[0].prompt as string);

  it('appends concrete turn tiers and a char budget to every merge', async () => {
    const old = prodDoc(base);
    compress.mockResolvedValueOnce(reply(old));
    await runProd(5000, old).promise;
    const [first] = prompts();
    expect(first).toContain('现在是 T120');
    expect(first).toContain('近期 T91–T120');
    expect(first).toContain('中期 T41–T90');
    expect(first).toContain('早期 T1–T40');
    // 未接近上限：允许按新章节的十分之一增长
    expect(first).toContain(`旧档案 ${countChars(old)} 字`);
    expect(first).toContain(`不超过 ${countChars(old) + 200} 字`);
    expect(first).toContain(
      '「一、亲密关系与进度」「三、用户偏好（成人向）」「四、用户的其他要求」只能新增或更新'
    );
    expect(first).not.toContain('不得净增长');
  });

  it('forbids net growth once the old archive passes 80% of the target', async () => {
    const old = prodDoc(base);
    const max = Math.ceil(countChars(old) / 0.85 / 0.85);
    compress.mockResolvedValueOnce(reply(old));
    await runProd(max, old).promise;
    const [first] = prompts();
    expect(first).toContain('不得净增长');
    expect(first).toContain(`不超过 ${countChars(old)} 字`);
    expect(first).toContain('「二、持续状态与规则」「六、主角现状」合并措辞');
  });

  it('retries an over-length merge once with per-section caps, never capping guarded sections', async () => {
    const long = prodDoc({ ...base, 6: [fill(200, 1), fill(200, 7)] });
    const fits = prodDoc(base);
    const max = countChars(long) - 50;
    compress.mockResolvedValueOnce(reply(long)).mockResolvedValueOnce(reply(fits));
    const { promise, onAttempt } = runProd(max, null);
    await expect(promise).resolves.toMatchObject({ content: fits });
    expect(compress).toHaveBeenCalledTimes(2);
    const retry = prompts()[1]!;
    expect(retry).toContain(`上次整份 ${countChars(long)} 字，超过上限 ${max} 字`);
    expect(retry).toMatch(/「七、故事主线与约定」上次 \d+ 字，这次压到 \d+ 字以内/);
    expect(retry).not.toMatch(/「一、亲密关系与进度」上次/);
    expect(onAttempt.mock.calls.map(([detail]) => [detail.stage, detail.attempt])).toEqual([
      ['merge', 1],
      ['merge', 2],
    ]);
  });

  it('rejects a merge that cuts a guarded section by more than 10% and names it in the retry', async () => {
    const old = prodDoc(base);
    const cut = prodDoc({ ...base, 0: [fill(150, 2)] });
    compress.mockResolvedValueOnce(reply(cut)).mockResolvedValueOnce(reply(old));
    const { promise, onRejected } = runProd(5000, old);
    await expect(promise).resolves.toMatchObject({ content: old });
    expect(onRejected).toHaveBeenCalledWith('guarded_shrink', expect.anything());
    expect(prompts()[1]).toContain('「一、亲密关系与进度」从');
  });

  it('fails after two calls when both merges are too long (no section-by-section shrinking)', async () => {
    const long = prodDoc({ ...base, 6: [fill(200, 1), fill(200, 7)] });
    compress.mockResolvedValue(reply(long));
    await expect(runProd(countChars(long) - 50, null).promise).rejects.toMatchObject({
      code: 'too_long',
    });
    expect(compress).toHaveBeenCalledTimes(2);
  });
});

describe('compression diagnostics and recovery boundaries', () => {
  beforeEach(() => compress.mockReset());

  it('records sizes (not content) and the budget as target_chars', async () => {
    const long = doc(LONG_PLOT);
    const max = countChars(long) - 10;
    compress.mockResolvedValueOnce(reply(long)).mockResolvedValueOnce(reply(doc([plotLine(1, 5)])));
    const { promise, onRejected, onAttempt } = run(vi.fn(), null, vi.fn(), max);
    await promise;
    expect(onRejected).toHaveBeenCalledWith(
      'too_long',
      expect.objectContaining({ attempt: 1, validation_max_chars: max, stage: 'merge' })
    );
    expect(onRejected.mock.calls[0]![1].history_chars).toBeGreaterThan(0);
    expect(onAttempt.mock.calls[1]![0]).toMatchObject({
      stage: 'merge',
      attempt: 2,
      // 首次编纂：字数上限 = 新章节的十分之一（不超过目标）
      target_chars: Math.min(memoryTargetChars(max), Math.ceil(countChars(HISTORY) * 0.1)),
    });
  });

  it('does not turn monitoring failure into another generation or rejected archive', async () => {
    compress.mockResolvedValueOnce(reply(archive(2)));
    const broken = () => {
      throw new Error('monitor unavailable');
    };
    const { promise } = run(vi.fn(broken), null, vi.fn(broken));
    await expect(promise).resolves.toMatchObject({ content: archive(2) });
    expect(compress).toHaveBeenCalledTimes(1);
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
