/**
 * 记忆栏：自由文字的剧情记录；按剧情记（没进展不动）、只追加新增、整份封顶。
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

const record =
  '你接手公寓的第三天，林晚在楼道里第一次对你说喜欢；同一晚，三楼的苏棠为房租和你吵了一架，摔门走了。';

const output = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ record, milestones: [], archive: null, summary: null, ...extra });

/** 每次检查都记下一段剧情，连续 n 次（每次 3 轮） */
function grow(n: number, start: MemoryBarState = EMPTY_MEMORY_BAR): MemoryBarState {
  let state = start;
  for (let k = 0; k < n; k += 1) {
    const tasks = planMemoryBarUpdate(state, state.covered_turn + 3)!;
    const result = applyMemoryBarOutput(
      state,
      tasks,
      output({
        milestones: [`节点${tasks.fromTurn}`],
        archive: tasks.archive ? '刚搬来那阵子，和几位房客从陌生到熟络。' : null,
        summary: tasks.fold ? '很早以前你在雨夜接手了这栋公寓。' : null,
      })
    );
    if (!result.ok) throw new Error(result.issues.join('；'));
    state = result.state;
  }
  return state;
}

describe('记忆栏：剧情记录，按剧情记', () => {
  it('有进展：追加一段文字，记到这次看到的最后一轮', () => {
    const tasks = planMemoryBarUpdate(EMPTY_MEMORY_BAR, 3)!;
    expect(tasks).toMatchObject({ fromTurn: 1, toTurn: 3, archive: null, fold: null });
    const result = applyMemoryBarOutput(EMPTY_MEMORY_BAR, tasks, '```json\n' + output() + '\n```');
    expect(result.ok && result.state.entries).toEqual([{ from_turn: 1, to_turn: 3, text: record }]);
    expect(result).toMatchObject({ ok: true, recorded: true, changed: true });
  });

  it('没进展：记忆不变，起点不挪，下次连这几轮一起看', () => {
    const recorded = grow(1);
    const result = applyMemoryBarOutput(
      recorded,
      planMemoryBarUpdate(recorded, 6)!,
      output({ record: '' })
    );
    expect(result).toMatchObject({ ok: true, changed: false, recorded: false });
    expect(result.ok && result.state).toEqual(recorded);
    expect(planMemoryBarUpdate(recorded, 9)).toMatchObject({ fromTurn: 4, toTurn: 9 });
  });

  it('没有新轮次就不用检查', () => {
    expect(planMemoryBarUpdate(grow(1), 3)).toBeNull();
  });

  it('提示词：剧情记录不是状态栏，不规定格式，有进展才写，每条线都写到', () => {
    expect(MEMORY_BAR_SYSTEM_PROMPT).toContain('人物现在的各项状态由状态栏另外记录');
    expect(MEMORY_BAR_SYSTEM_PROMPT).toContain('按剧情记，不按轮次记');
    expect(MEMORY_BAR_SYSTEM_PROMPT).toContain('不要为了记而记');
    expect(MEMORY_BAR_SYSTEM_PROMPT).toContain('不要只写主角色');
    expect(MEMORY_BAR_SYSTEM_PROMPT).toContain('写法不限');
  });

  it('只检查长度：太长退回，不是 JSON 退回', () => {
    const tasks = planMemoryBarUpdate(EMPTY_MEMORY_BAR, 3)!;
    expect(
      applyMemoryBarOutput(
        EMPTY_MEMORY_BAR,
        tasks,
        output({ record: '很'.repeat(L.entryMaxChars + 1) })
      )
    ).toEqual({ ok: false, issues: [`剧情记录太长，不超过 ${L.entryChars} 字`] });
    expect(applyMemoryBarOutput(EMPTY_MEMORY_BAR, tasks, '好的，我来记录。').ok).toBe(false);
  });

  it('里程碑一句话一条，最多 4 条，和已有的重复就不加', () => {
    const first = grow(1); // 已有「节点1」
    const result = applyMemoryBarOutput(
      first,
      planMemoryBarUpdate(first, 6)!,
      output({
        milestones: ['节点1', '林晚表白', '和苏棠第一次吵架', '交出备用钥匙', '房客聚餐', '第六条'],
      })
    );
    expect(result.ok && result.newMilestones).toBe(4);
    expect(result.ok && result.state.milestones.map((m) => m.text)).toEqual([
      '节点1',
      '林晚表白',
      '和苏棠第一次吵架',
      '交出备用钥匙',
      '房客聚餐',
    ]);
  });
});

describe('记忆栏：长度封顶，越久远越粗', () => {
  it('剧情记录满了，最早几段压缩成一段；没压缩就退回', () => {
    const full = grow(L.entries);
    const tasks = planMemoryBarUpdate(full, full.covered_turn + 3)!;
    expect(tasks.archive).toHaveLength(L.archiveMergeCount);
    expect(applyMemoryBarOutput(full, tasks, output())).toEqual({
      ok: false,
      issues: ['要求压缩最早几段剧情记录，但没有写 archive'],
    });
    const next = grow(1, full);
    expect(next.entries).toHaveLength(L.entries - L.archiveMergeCount + 1);
    expect(next.archives).toEqual([
      {
        from_turn: 1,
        to_turn: 3 * L.archiveMergeCount,
        text: '刚搬来那阵子，和几位房客从陌生到熟络。',
      },
    ]);
  });

  it('聊很久也封顶：更早的剧情、里程碑超出的并进前情概要', () => {
    const state = grow(300);
    expect(state.entries.length).toBeLessThanOrEqual(L.entries);
    expect(state.archives.length).toBeLessThanOrEqual(L.archives);
    expect(state.milestones.length).toBeLessThanOrEqual(L.milestones);
    expect(state.summary).toContain('雨夜');
    expect([...memoryBarText(state)].length).toBeLessThan(9000);
  });

  it('老会话第一次：旧记忆区原文并进前情概要，从那条回复之后看起', () => {
    const tasks = planMemoryBarUpdate(EMPTY_MEMORY_BAR, 45, {
      text: '[memory]旧的记忆[/memory]',
      turn: 40,
    })!;
    expect(tasks).toMatchObject({ fromTurn: 41, toTurn: 45 });
    const { user } = buildMemoryBarPromptMessages({
      character: { name: '房东模拟器' },
      state: EMPTY_MEMORY_BAR,
      tasks,
      turns: [
        { index: 40, user: '上一轮', reply: '已经记过的' },
        { index: 41, user: '你好', reply: '她笑了' },
      ],
    });
    expect(user).toContain('【已记过】玩家：上一轮');
    expect(user).toContain('玩家：你好');
    expect(user).not.toContain('第41轮');
    expect(user).toContain('旧的记忆');
    const result = applyMemoryBarOutput(
      EMPTY_MEMORY_BAR,
      tasks,
      output({ record: '', summary: '以前的事。' })
    );
    expect(result.ok && result.state).toMatchObject({ covered_turn: 40, summary: '以前的事。' });
  });
});
