/**
 * 记忆栏：按上限决定合并、只追加新增、整份封顶。
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_MEMORY_BAR,
  MEMORY_BAR_LIMITS,
  applyMemoryBarOutput,
  buildMemoryBarPromptMessages,
  memoryBarText,
  planMemoryBarUpdate,
  type MemoryBarState,
} from '../index';

const L = MEMORY_BAR_LIMITS;

const entryOut = {
  time: '周四 深夜',
  feeling: '和林晚确认了心意，关系升温',
  acts: '在客厅沙发上接吻',
  state: '林晚脸红、心跳很快',
  hooks: '约好周末一起去海边',
};

const output = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ entry: entryOut, milestones: [], archive: null, summary: null, ...extra });

/** 连续追加 n 次，模拟聊了 3n 轮 */
function grow(n: number, start: MemoryBarState = EMPTY_MEMORY_BAR): MemoryBarState {
  let state = start;
  for (let k = 0; k < n; k += 1) {
    const from = (state.entries.at(-1)?.to_turn ?? state.archives.at(-1)?.to_turn ?? 0) + 1;
    const tasks = planMemoryBarUpdate(state, { fromTurn: from, toTurn: from + 2 });
    const result = applyMemoryBarOutput(
      state,
      tasks,
      output({
        milestones: [{ time: '周四', who: '林晚', text: `第${from}轮的关键节点` }],
        archive: tasks.archive
          ? {
              time_range: '第一周',
              line: '从陌生到暧昧',
              intimacy: '接吻、牵手',
              changes: '越来越依赖',
              hooks: '海边之约',
            }
          : null,
        summary: tasks.fold ? '很早以前两人在雨夜相识，之后慢慢走近。' : null,
      })
    );
    if (!result.ok) throw new Error(result.issues.join('；'));
    state = result.state;
  }
  return state;
}

describe('记忆栏：每次更新追加一条工作记忆', () => {
  it('第一次记录：一条工作记忆，轮次由代码填', () => {
    const tasks = planMemoryBarUpdate(EMPTY_MEMORY_BAR, { fromTurn: 1, toTurn: 3 });
    expect(tasks).toMatchObject({ archive: null, fold: null });
    const result = applyMemoryBarOutput(EMPTY_MEMORY_BAR, tasks, '```json\n' + output() + '\n```');
    expect(result.ok && result.state.entries).toEqual([{ from_turn: 1, to_turn: 3, ...entryOut }]);
  });

  it('缺项或太长都退回给兜底，附问题', () => {
    const tasks = planMemoryBarUpdate(EMPTY_MEMORY_BAR, { fromTurn: 1, toTurn: 3 });
    const missing = applyMemoryBarOutput(
      EMPTY_MEMORY_BAR,
      tasks,
      JSON.stringify({ entry: { ...entryOut, acts: '' } })
    );
    expect(missing).toEqual({ ok: false, issues: ['工作记忆缺了「做过什么」'] });
    const long = applyMemoryBarOutput(
      EMPTY_MEMORY_BAR,
      tasks,
      output({ entry: { ...entryOut, state: '很'.repeat(L.entryFieldMaxChars + 1) } })
    );
    expect(long.ok).toBe(false);
    expect(applyMemoryBarOutput(EMPTY_MEMORY_BAR, tasks, '好的，我来记录。').ok).toBe(false);
  });

  it('里程碑最多 3 条，和已有的重复就不加', () => {
    const first = grow(1);
    const tasks = planMemoryBarUpdate(first, { fromTurn: 4, toTurn: 6 });
    const result = applyMemoryBarOutput(
      first,
      tasks,
      output({
        milestones: [
          { time: '周五', who: '林晚', text: '第1轮的关键节点' },
          { time: '周五', who: '林晚', text: '第一次一起过夜' },
          { time: '周五', who: '林晚', text: '确认恋人关系' },
          { time: '周五', who: '林晚', text: '交换了钥匙' },
          { time: '周五', who: '林晚', text: '见了她的朋友' },
        ],
      })
    );
    expect(result.ok && result.newMilestones).toBe(3);
    expect(result.ok && result.state.milestones.map((m) => m.text)).toEqual([
      '第1轮的关键节点',
      '第一次一起过夜',
      '确认恋人关系',
      '交换了钥匙',
    ]);
  });
});

describe('记忆栏：长度封顶，越久远越粗', () => {
  it('工作记忆满 10 条时，最早 10 条合并成一条历史档案', () => {
    const full = grow(L.entries);
    const tasks = planMemoryBarUpdate(full, { fromTurn: 31, toTurn: 33 });
    expect(tasks.archive).toHaveLength(L.entries);
    const missing = applyMemoryBarOutput(full, tasks, output());
    expect(missing).toEqual({ ok: false, issues: ['要求合并历史档案，但没有写 archive'] });
    const next = grow(1, full);
    expect(next.entries).toHaveLength(1);
    expect(next.archives).toEqual([
      expect.objectContaining({ from_turn: 1, to_turn: 30, line: '从陌生到暧昧' }),
    ]);
  });

  it('聊很久也封顶：档案、里程碑超出的并进前情概要', () => {
    // 约 600 轮
    const state = grow(200);
    expect(state.entries.length).toBeLessThanOrEqual(L.entries);
    expect(state.archives.length).toBeLessThanOrEqual(L.archives);
    expect(state.milestones.length).toBeLessThanOrEqual(L.milestones);
    expect(state.summary).toContain('雨夜相识');
    expect([...memoryBarText(state)].length).toBeLessThan(6000);
  });

  it('里程碑快满时，最早几条并进前情概要；没写概要就退回', () => {
    const state: MemoryBarState = {
      ...grow(1),
      milestones: Array.from({ length: L.milestones - L.newMilestonesPerUpdate + 1 }, (_, k) => ({
        turn: k + 1,
        time: '不详',
        who: '林晚',
        text: `节点${k}`,
      })),
    };
    const tasks = planMemoryBarUpdate(state, { fromTurn: 900, toTurn: 902 });
    expect(tasks.fold?.milestones).toHaveLength(L.milestoneFoldCount);
    expect(applyMemoryBarOutput(state, tasks, output())).toEqual({
      ok: false,
      issues: ['要求改写前情概要，但没有写 summary'],
    });
    const done = applyMemoryBarOutput(state, tasks, output({ summary: '早年的事。' }));
    expect(done.ok && done.state.milestones[0]?.text).toBe(`节点${L.milestoneFoldCount}`);
    expect(done.ok && done.state.summary).toBe('早年的事。');
  });

  it('老会话第一次：旧记忆区原文并进前情概要', () => {
    const tasks = planMemoryBarUpdate(
      EMPTY_MEMORY_BAR,
      { fromTurn: 40, toTurn: 42 },
      '[memory]旧的记忆[/memory]'
    );
    expect(tasks.fold?.legacyText).toContain('旧的记忆');
    const { user } = buildMemoryBarPromptMessages({
      character: { name: '林晚' },
      state: EMPTY_MEMORY_BAR,
      tasks,
      turns: [
        { index: 39, user: '上一轮', reply: '已经记过的' },
        { index: 40, user: '你好', reply: '她笑了' },
      ],
    });
    expect(user).toContain('【已计入】第39轮');
    expect(user).toContain('【新】第40轮');
    expect(user).toContain('改写前情概要');
    expect(user).toContain('旧的记忆');
  });
});
