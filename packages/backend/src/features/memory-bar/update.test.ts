/**
 * 记忆检查编排：取模触发、主通道→兜底、没进展不写库、冲突放弃、开关关闭不检查；
 * 日志走真实 Pino JSON，断言有结果摘要、没有记忆正文和玩家要求原文。
 */
import pino from 'pino';
import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MEMORY_BAR } from '@miniapp/shared';
import { fastifyLoggerOptions, requestLogger } from '../../platform/observability/logger.js';

const mocks = vi.hoisted(() => ({
  readSession: vi.fn(),
  readRecentTurns: vi.fn(),
  readCharacterRuntime: vi.fn(),
  readShowMemory: vi.fn(),
  readCurrent: vi.fn(),
  readTurns: vi.fn(),
  readLatestLegacyMemoryTurn: vi.fn(),
  readRequest: vi.fn(),
  record: vi.fn(),
  callStatusModel: vi.fn(),
  fetchMemoryBarPrompt: vi.fn(),
}));

vi.mock('../status-bar/template.js', () => ({
  statusRepo: () => ({
    readSession: mocks.readSession,
    readRecentTurns: mocks.readRecentTurns,
    readCharacterRuntime: mocks.readCharacterRuntime,
  }),
}));
vi.mock('../../infrastructure/repositories/MemoryBarRepository.js', () => ({
  MemoryBarRepository: class {
    readShowMemory = mocks.readShowMemory;
    readCurrent = mocks.readCurrent;
    readTurns = mocks.readTurns;
    readLatestLegacyMemoryTurn = mocks.readLatestLegacyMemoryTurn;
    readRequest = mocks.readRequest;
    record = mocks.record;
  },
}));
vi.mock('./config.js', () => ({ fetchMemoryBarPrompt: mocks.fetchMemoryBarPrompt }));
vi.mock('../generation/status-bar-model.js', () => {
  class StatusModelError extends Error {
    constructor(
      readonly code: string,
      readonly channel: 'primary' | 'fallback'
    ) {
      super(`status_bar_model_${channel}_${code}`);
    }
  }
  return { StatusModelError, callStatusModel: mocks.callStatusModel };
});

const { isMemoryCheckDue, legacyMemoryText, runMemoryCheck } = await import('./update.js');
const { StatusModelError } = await import('../generation/status-bar-model.js');

const SECRET_RECORD = '林晚在楼道里第一次说喜欢你，两人接了吻。';
const SECRET_REQUEST = '着重记录好墨尘和我的关系';

function captureLogs() {
  const lines: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const base = pino({ ...fastifyLoggerOptions(), level: 'info', transport: undefined }, output);
  return { lines, log: requestLogger(base, 'status-bar') };
}

const reply = (record: string, extra: Record<string, unknown> = {}) => ({
  content: JSON.stringify({ record, milestones: [], compress: {}, summary: null, ...extra }),
  channel: 'primary',
  model: 'm',
});

const turns = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, k) => ({
    historyId: `h${from + k}`,
    turnIndex: from + k,
    userInput: `玩家${from + k}`,
    assistantReply: `回复${from + k}`,
  }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readSession.mockResolvedValue({ characterId: 'c1' });
  mocks.readShowMemory.mockResolvedValue(true);
  mocks.readCurrent.mockResolvedValue(null);
  mocks.readRecentTurns.mockResolvedValue(turns(3, 3));
  mocks.readLatestLegacyMemoryTurn.mockResolvedValue(null);
  mocks.readTurns.mockResolvedValue(turns(1, 3));
  mocks.readCharacterRuntime.mockResolvedValue({
    name: '房东模拟器',
    description: '',
    statusBar: null,
  });
  mocks.readRequest.mockResolvedValue(SECRET_REQUEST);
  mocks.record.mockResolvedValue('snap-1');
  mocks.fetchMemoryBarPrompt.mockResolvedValue({ text: '运营写的记忆规则', version: 3 });
});

const input = (log: ReturnType<typeof captureLogs>['log']) => ({
  userId: 'u1',
  sessionId: '00000000-0000-4000-8000-000000000001',
  trigger: 'manual' as const,
  log,
});

const updateLog = (lines: string[]) =>
  lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((l) => l.event === 'memory_bar.update');

describe('记忆检查的节奏', () => {
  it('距上次记下东西满 3 轮的整数倍才检查', () => {
    expect([2, 3, 4, 5, 6, 9].map((latest) => isMemoryCheckDue(latest, 0))).toEqual([
      false,
      true,
      false,
      false,
      true,
      true,
    ]);
    expect(isMemoryCheckDue(10, 7)).toBe(true);
    expect(isMemoryCheckDue(10, 8)).toBe(false);
  });

  it('旧记忆区取最后一个（含没闭合的）', () => {
    expect(legacyMemoryText('正文[memory]旧的[/memory]\n又一段[memory]最新的')).toBe('最新的');
    expect(legacyMemoryText('没有记忆区')).toBe('');
  });
});

describe('一次记忆检查', () => {
  it('主通道有进展：落库（比对读到的那条）、日志只有摘要、提示词带玩家要求', async () => {
    const { log, lines } = captureLogs();
    mocks.callStatusModel.mockResolvedValueOnce(reply(SECRET_RECORD));
    await expect(runMemoryCheck(input(log))).resolves.toEqual({ outcome: 'recorded' });
    expect(mocks.callStatusModel).toHaveBeenCalledTimes(1);
    expect(mocks.callStatusModel.mock.calls[0]![1].user).toContain(SECRET_REQUEST);
    expect(mocks.callStatusModel.mock.calls[0]![1].system).toMatch(/^运营写的记忆规则\n\n输出要求/);
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPreviousId: null,
        anchor: { historyId: 'h3', turnIndex: 3 },
        promptVersion: 3,
        state: expect.objectContaining({ covered_turn: 3 }),
      })
    );
    expect(updateLog(lines)).toMatchObject({
      kind: 'biz',
      outcome: 'succeeded',
      reason: 'recorded',
      provider: 'primary',
      attemptCount: 1,
      requestCount: 1,
      prompt_version: 'v3',
    });
    const all = lines.join('\n');
    expect(all).not.toContain('林晚');
    expect(all).not.toContain('墨尘');
  });

  it('主通道超时转兜底，兜底成功照样落库', async () => {
    const { log, lines } = captureLogs();
    mocks.callStatusModel
      .mockRejectedValueOnce(new StatusModelError('first_token_timeout', 'primary'))
      .mockResolvedValueOnce(reply(SECRET_RECORD));
    await expect(runMemoryCheck(input(log))).resolves.toEqual({ outcome: 'recorded' });
    expect(mocks.callStatusModel.mock.calls.map((c) => c[0])).toEqual(['primary', 'fallback']);
    expect(updateLog(lines)).toMatchObject({ provider: 'fallback', attemptCount: 2 });
    expect(lines.some((l) => l.includes('memory_bar.primary.failed'))).toBe(true);
  });

  it('主通道不是合法 JSON 时兜底带上问题清单；两次都不合格就不写库', async () => {
    const { log, lines } = captureLogs();
    mocks.callStatusModel
      .mockResolvedValueOnce({ content: '好的，我来记录。', channel: 'primary', model: 'm' })
      .mockResolvedValueOnce({ content: '还是没有 JSON', channel: 'fallback', model: 'm' });
    await expect(runMemoryCheck(input(log))).resolves.toEqual({ outcome: 'failed' });
    expect(mocks.callStatusModel.mock.calls[1]![1].user).toContain('【上一次输出的问题】');
    expect(mocks.record).not.toHaveBeenCalled();
    expect(updateLog(lines)).toMatchObject({ outcome: 'failed', reason: 'invalid', issueCount: 1 });
  });

  it('主通道只是新记录超长：直接降级截断写库，不再调兜底', async () => {
    const { log, lines } = captureLogs();
    mocks.callStatusModel.mockResolvedValueOnce(reply(`${'她笑了，转身离开。'.repeat(60)}`));
    await expect(runMemoryCheck(input(log))).resolves.toEqual({ outcome: 'recorded' });
    expect(mocks.callStatusModel).toHaveBeenCalledTimes(1);
    const saved = mocks.record.mock.calls[0]![0].state.records.at(-1);
    expect([...saved.text].length).toBeLessThanOrEqual(360);
    expect(updateLog(lines)).toMatchObject({
      outcome: 'succeeded',
      provider: 'primary',
      attemptCount: 1,
      degradedCount: 1,
    });
  });

  it('没进展：不写库', async () => {
    const { log, lines } = captureLogs();
    mocks.callStatusModel.mockResolvedValueOnce(reply(''));
    await expect(runMemoryCheck(input(log))).resolves.toEqual({ outcome: 'no_progress' });
    expect(mocks.record).not.toHaveBeenCalled();
    expect(updateLog(lines)).toMatchObject({ outcome: 'skipped', reason: 'no_progress' });
  });

  it('读到的那条已不是最新（别的检查先写了）：放弃本次', async () => {
    const { log, lines } = captureLogs();
    mocks.readCurrent.mockResolvedValue({
      id: 'snap-0',
      state: EMPTY_MEMORY_BAR,
      anchorTurn: 1,
      trigger: 'auto',
      createdAt: '',
    });
    mocks.record.mockResolvedValueOnce(null);
    mocks.callStatusModel.mockResolvedValueOnce(reply(SECRET_RECORD));
    await expect(runMemoryCheck(input(log))).resolves.toEqual({ outcome: 'skipped' });
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ expectedPreviousId: 'snap-0' })
    );
    expect(updateLog(lines)).toMatchObject({ outcome: 'skipped', reason: 'conflict' });
  });

  it('运营平台没有可用的 prompt：不检查、不调模型，记 error', async () => {
    const { log, lines } = captureLogs();
    mocks.fetchMemoryBarPrompt.mockResolvedValue(null);
    await expect(runMemoryCheck(input(log))).resolves.toEqual({ outcome: 'failed' });
    expect(mocks.callStatusModel).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('memory_bar.prompt.unavailable'))).toBe(true);
  });

  it('记忆栏开关关着：不检查、不调模型', async () => {
    const { log } = captureLogs();
    mocks.readShowMemory.mockResolvedValue(false);
    await expect(runMemoryCheck(input(log))).resolves.toEqual({ outcome: 'skipped' });
    expect(mocks.callStatusModel).not.toHaveBeenCalled();
  });

  it('老会话第一次：旧记忆区并进前情概要，从那条回复之后看起', async () => {
    const { log } = captureLogs();
    mocks.readRecentTurns.mockResolvedValue(turns(12, 12));
    mocks.readLatestLegacyMemoryTurn.mockResolvedValue({
      ...turns(10, 10)[0],
      assistantReply: '正文[memory]旧的记忆[/memory]',
    });
    mocks.readTurns.mockResolvedValue(turns(9, 12));
    mocks.callStatusModel.mockResolvedValueOnce(reply('', { summary: '很早以前的事。' }));
    await expect(runMemoryCheck(input(log))).resolves.toEqual({ outcome: 'recorded' });
    expect(mocks.readTurns).toHaveBeenCalledWith(expect.any(String), 9, 12, 43);
    expect(mocks.callStatusModel.mock.calls[0]![1].user).toContain('旧的记忆');
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({ covered_turn: 10, summary: '很早以前的事。' }),
      })
    );
  });
});
