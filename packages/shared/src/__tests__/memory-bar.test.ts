/**
 * 记忆栏：按事件记（没进展不动）、只追加新增、整份封顶。
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_MEMORY_BAR,
  MEMORY_BAR_LIMITS,
  MEMORY_BAR_SYSTEM_PROMPT,
  applyMemoryBarOutput,
  buildMemoryBarPromptMessages,
  memoryBarText,
  planMemoryBarUpdate,
  type MemoryBarState,
} from '../index';

const L = MEMORY_BAR_LIMITS;

const event = {
  time: '周四 深夜',
  title: '林晚第一次说喜欢你',
  feeling: '确认了心意，关系升温',
  acts: '在客厅沙发上接吻',
  state: '她脸红、心跳很快',
  hooks: '约好周末一起去海边',
};

const output = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ events: [event], milestones: [], archive: null, summary: null, ...extra });

/** 每次检查都记下一件事，连续 n 次（每次 3 轮） */
function grow(n: number, start: MemoryBarState = EMPTY_MEMORY_BAR): MemoryBarState {
  let state = start;
  for (let k = 0; k < n; k += 1) {
    const tasks = planMemoryBarUpdate(state, state.covered_turn + 3)!;
    const result = applyMemoryBarOutput(
      state,
      tasks,
      output({
        milestones: [{ time: '周四', who: '林晚', text: `节点${tasks.fromTurn}` }],
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

describe('记忆栏：按事件记，没进展不动', () => {
  it('有进展：记一件事，记到这次看到的最后一轮', () => {
    const tasks = planMemoryBarUpdate(EMPTY_MEMORY_BAR, 3)!;
    expect(tasks).toMatchObject({ fromTurn: 1, toTurn: 3, archive: null, fold: null });
    const result = applyMemoryBarOutput(EMPTY_MEMORY_BAR, tasks, '```json\n' + output() + '\n```');
    expect(result.ok && result.state.entries).toEqual([{ from_turn: 1, to_turn: 3, ...event }]);
    expect(result.ok && result.state.covered_turn).toBe(3);
  });

  it('没进展：记忆不变，起点不挪，下次连这几轮一起看', () => {
    const recorded = grow(1); // 记到第 3 轮
    const quiet = planMemoryBarUpdate(recorded, 6)!;
    const result = applyMemoryBarOutput(recorded, quiet, output({ events: [] }));
    expect(result).toMatchObject({ ok: true, changed: false, newEvents: 0 });
    expect(result.ok && result.state).toEqual(recorded);
    // 第 9 轮再看：从第 4 轮看起，第 4–6 轮的小变化不会丢
    expect(planMemoryBarUpdate(recorded, 9)).toMatchObject({ fromTurn: 4, toTurn: 9 });
  });

  it('提示词贯彻「没进展就不写」', () => {
    expect(MEMORY_BAR_SYSTEM_PROMPT).toContain('按事件记，不按轮次记');
    expect(MEMORY_BAR_SYSTEM_PROMPT).toContain('不要为了记而记');
    expect(MEMORY_BAR_SYSTEM_PROMPT).toContain('没有进展写 []');
  });

  it('没有新轮次就不用检查', () => {
    expect(planMemoryBarUpdate(grow(1), 3)).toBeNull();
  });

  it('缺项、太长、件数超了都退回给兜底', () => {
    const tasks = planMemoryBarUpdate(EMPTY_MEMORY_BAR, 3)!;
    expect(
      applyMemoryBarOutput(EMPTY_MEMORY_BAR, tasks, output({ events: [{ ...event, acts: '' }] }))
    ).toEqual({ ok: false, issues: ['事件缺了「做过什么」（没有就写"无"）'] });
    expect(
      applyMemoryBarOutput(
        EMPTY_MEMORY_BAR,
        tasks,
        output({ events: [{ ...event, state: '很'.repeat(L.entryFieldMaxChars + 1) }] })
      ).ok
    ).toBe(false);
    expect(
      applyMemoryBarOutput(EMPTY_MEMORY_BAR, tasks, output({ events: [event, event, event] })).ok
    ).toBe(false);
    expect(applyMemoryBarOutput(EMPTY_MEMORY_BAR, tasks, '好的，我来记录。').ok).toBe(false);
  });

  it('里程碑最多 3 条，和已有的重复就不加', () => {
    const first = grow(1);
    const tasks = planMemoryBarUpdate(first, 6)!;
    const result = applyMemoryBarOutput(
      first,
      tasks,
      output({
        milestones: [
          { time: '周五', who: '林晚', text: '节点1' },
          { time: '周五', who: '林晚', text: '第一次一起过夜' },
          { time: '周五', who: '林晚', text: '确认恋人关系' },
          { time: '周五', who: '林晚', text: '交换了钥匙' },
          { time: '周五', who: '林晚', text: '见了她的朋友' },
        ],
      })
    );
    expect(result.ok && result.newMilestones).toBe(3);
    expect(result.ok && result.state.milestones.map((m) => m.text)).toEqual([
      '节点1',
      '第一次一起过夜',
      '确认恋人关系',
      '交换了钥匙',
    ]);
  });
});

describe('记忆栏：长度封顶，越久远越粗', () => {
  it('近期事件快满时，最早几件合并成一条历史档案', () => {
    const almost = grow(L.entries - L.newEntriesPerUpdate + 1);
    const tasks = planMemoryBarUpdate(almost, almost.covered_turn + 3)!;
    expect(tasks.archive).toHaveLength(L.archiveMergeCount);
    expect(applyMemoryBarOutput(almost, tasks, output())).toEqual({
      ok: false,
      issues: ['要求合并历史档案，但没有写 archive'],
    });
    const next = grow(1, almost);
    expect(next.entries.length).toBe(almost.entries.length - L.archiveMergeCount + 1);
    expect(next.archives).toEqual([
      expect.objectContaining({
        from_turn: 1,
        to_turn: 3 * L.archiveMergeCount,
        line: '从陌生到暧昧',
      }),
    ]);
  });

  it('聊很久也封顶：档案、里程碑超出的并进前情概要', () => {
    const state = grow(300);
    expect(state.entries.length).toBeLessThanOrEqual(L.entries);
    expect(state.archives.length).toBeLessThanOrEqual(L.archives);
    expect(state.milestones.length).toBeLessThanOrEqual(L.milestones);
    expect(state.summary).toContain('雨夜相识');
    expect([...memoryBarText(state)].length).toBeLessThan(6000);
  });

  it('老会话第一次：旧记忆区原文并进前情概要，从那条回复之后看起', () => {
    const tasks = planMemoryBarUpdate(EMPTY_MEMORY_BAR, 45, {
      text: '[memory]旧的记忆[/memory]',
      turn: 40,
    })!;
    expect(tasks).toMatchObject({ fromTurn: 41, toTurn: 45 });
    expect(tasks.fold?.legacy?.text).toContain('旧的记忆');
    const { user } = buildMemoryBarPromptMessages({
      character: { name: '林晚' },
      state: EMPTY_MEMORY_BAR,
      tasks,
      turns: [
        { index: 40, user: '上一轮', reply: '已经记过的' },
        { index: 41, user: '你好', reply: '她笑了' },
      ],
    });
    expect(user).toContain('【已记过】第40轮');
    expect(user).toContain('第41轮 玩家：你好');
    expect(user).toContain('改写前情概要');
    expect(user).toContain('旧的记忆');
    // 没进展也要把旧记忆并进来，起点挪到那条回复
    const result = applyMemoryBarOutput(
      EMPTY_MEMORY_BAR,
      tasks,
      output({ events: [], summary: '以前的事。' })
    );
    expect(result.ok && result.state).toMatchObject({ covered_turn: 40, summary: '以前的事。' });
  });
});
