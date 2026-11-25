/**
 * 记忆栏：自由文字的剧情记录；按剧情记（没进展不动）、只追加新增；
 * 越近越详细、越远越简略（近 / 中 / 远 / 很远四档），整份封顶 4000 字。
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_MEMORY_BAR,
  MEMORY_BAR_LIMITS,
  MEMORY_BAR_MAX_RECORDS,
  MEMORY_BAR_OUTPUT_RULES,
  MemoryBarPromptSchema,
  MemoryBarStateSchema,
  MEMORY_BAR_TIERS,
  applyMemoryBarOutput,
  buildMemoryBarPromptMessages,
  memoryBarChars,
  planMemoryBarUpdate,
  rebaseMemoryBarState,
  type MemoryBarState,
  type MemoryBarTasks,
} from '../index';

const L = MEMORY_BAR_LIMITS;

const record =
  '你接手公寓的第三天，林晚在楼道里第一次对你说喜欢；同一晚，三楼的苏棠为房租和你吵了一架，摔门走了。';

const output = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ record, milestones: [], compress: {}, summary: null, ...extra });

interface GrowTexts {
  record: (tasks: MemoryBarTasks) => string;
  milestone: (tasks: MemoryBarTasks) => string;
  mid: string;
  far: string;
  summary: string;
}

const shortTexts: GrowTexts = {
  record: () => record,
  milestone: (tasks) => `节点${tasks.fromTurn}`,
  mid: '压成两三句话：林晚表白，和苏棠吵翻。',
  far: '林晚表白。',
  summary: '很早以前你在雨夜接手了这栋公寓。',
};

/** 每次检查都记下一段剧情，连续 n 次（每次 3 轮） */
function grow(n: number, start: MemoryBarState = EMPTY_MEMORY_BAR, texts = shortTexts) {
  let state = start;
  for (let k = 0; k < n; k += 1) {
    const tasks = planMemoryBarUpdate(state, state.covered_turn + 3)!;
    const compress = Object.fromEntries(
      tasks.compress.map((t) => [t.key, t.to === 'far' ? texts.far : texts.mid])
    );
    const result = applyMemoryBarOutput(
      state,
      tasks,
      output({
        record: texts.record(tasks),
        milestones: [texts.milestone(tasks)],
        compress,
        summary: tasks.fold ? texts.summary : null,
      })
    );
    if (!result.ok) throw new Error(result.issues.join('；'));
    state = result.state;
  }
  return state;
}

const tiersOf = (state: MemoryBarState) => state.records.map((r) => r.tier);

describe('记忆栏：剧情记录，按剧情记', () => {
  it('有进展：追加一段完整叙述，记到这次看到的最后一轮', () => {
    const tasks = planMemoryBarUpdate(EMPTY_MEMORY_BAR, 3)!;
    expect(tasks).toMatchObject({ fromTurn: 1, toTurn: 3, compress: [], fold: null });
    const result = applyMemoryBarOutput(EMPTY_MEMORY_BAR, tasks, '```json\n' + output() + '\n```');
    expect(result.ok && result.state.records).toEqual([
      { from_turn: 1, to_turn: 3, tier: 'near', text: record },
    ]);
    expect(result).toMatchObject({ ok: true, recorded: true, changed: true });
  });

  it('没进展：记忆不变，起点不挪；压短和前情概要也不用（前面的没往远挪）', () => {
    const recorded = grow(L.tiers.near.count);
    const tasks = planMemoryBarUpdate(recorded, recorded.covered_turn + 3)!;
    expect(tasks.compress).toHaveLength(1);
    const result = applyMemoryBarOutput(recorded, tasks, output({ record: '' }));
    expect(result).toMatchObject({ ok: true, changed: false, recorded: false });
    expect(result.ok && result.state).toEqual(recorded);
    expect(planMemoryBarUpdate(recorded, recorded.covered_turn + 6)).toMatchObject({
      fromTurn: recorded.covered_turn + 1,
    });
  });

  it('没有新轮次就不用检查', () => {
    expect(planMemoryBarUpdate(grow(1), 3)).toBeNull();
  });

  it('system = 运营平台的 prompt + 系统固定的输出要求（字段、字数与校验一致）', () => {
    const { system } = buildMemoryBarPromptMessages({
      systemPrompt: '  运营写的记忆规则  ',
      character: { name: '卡' },
      state: EMPTY_MEMORY_BAR,
      tasks: planMemoryBarUpdate(EMPTY_MEMORY_BAR, 3)!,
      turns: [],
    });
    expect(system).toBe(`运营写的记忆规则\n\n${MEMORY_BAR_OUTPUT_RULES}`);
    for (const field of ['"record"', '"milestones"', '"compress"', '"summary"'])
      expect(MEMORY_BAR_OUTPUT_RULES).toContain(field);
    expect(MEMORY_BAR_OUTPUT_RULES).toContain(`不超过 ${L.tiers.near.chars} 字`);
    expect(MemoryBarPromptSchema.safeParse('   ').success).toBe(false);
  });

  it('玩家对记忆的要求：放在已有记忆前面，内容上优先照办；没写就不出现', () => {
    const tasks = planMemoryBarUpdate(EMPTY_MEMORY_BAR, 3)!;
    const base = {
      systemPrompt: 'P',
      character: { name: '房东模拟器' },
      state: EMPTY_MEMORY_BAR,
      tasks,
      turns: [{ index: 1, user: '你好', reply: '她笑了' }],
    };
    const { user } = buildMemoryBarPromptMessages({
      ...base,
      playerRequest: '  着重记录好墨尘和我的关系  ',
    });
    expect(user).toContain(
      '【玩家对记忆的要求】（优先级最高，内容上一律照办）\n着重记录好墨尘和我的关系'
    );
    expect(user.indexOf('【玩家对记忆的要求】')).toBeLessThan(user.indexOf('【已有记忆】'));
    expect(user).toContain('全程优先照【玩家对记忆的要求】来记');
    for (const playerRequest of [undefined, null, '   ']) {
      expect(buildMemoryBarPromptMessages({ ...base, playerRequest }).user).not.toContain(
        '玩家对记忆的要求'
      );
    }
  });

  it('只检查长度：太长退回，不是 JSON 退回', () => {
    const tasks = planMemoryBarUpdate(EMPTY_MEMORY_BAR, 3)!;
    expect(
      applyMemoryBarOutput(
        EMPTY_MEMORY_BAR,
        tasks,
        output({ record: '很'.repeat(L.tiers.near.maxChars + 1) })
      )
    ).toEqual({
      ok: false,
      issues: [`剧情记录太长，不超过 ${L.tiers.near.chars} 字`],
      stage: 'content',
      problems: ['record_too_long'],
    });
    expect(applyMemoryBarOutput(EMPTY_MEMORY_BAR, tasks, '好的，我来记录。')).toMatchObject({
      ok: false,
      stage: 'format',
      problems: ['json_invalid'],
    });
  });

  it('里程碑一句话一条，每次最多 1 条，和已有的重复就不加', () => {
    const first = grow(1); // 已有「节点1」
    const result = applyMemoryBarOutput(
      first,
      planMemoryBarUpdate(first, 6)!,
      output({ milestones: ['节点1', '林晚表白', '和苏棠第一次吵架', '交出备用钥匙', '房客聚餐'] })
    );
    expect(result.ok && result.newMilestones).toBe(L.newMilestonesPerUpdate);
    expect(result.ok && result.state.milestones.map((m) => m.text)).toEqual(['节点1', '林晚表白']);
  });
});

describe('记忆栏：越近越详细，越远越简略', () => {
  it('近的放满后，最早一段往「中」挪：压成两三句话；没压就退回', () => {
    const full = grow(L.tiers.near.count);
    const tasks = planMemoryBarUpdate(full, full.covered_turn + 3)!;
    expect(tasks.compress).toMatchObject([{ key: 'A', index: 0, to: 'mid' }]);
    expect(
      buildMemoryBarPromptMessages({
        systemPrompt: 'P',
        character: { name: '卡' },
        state: full,
        tasks,
        turns: [],
      }).user
    ).toContain(`A（压成两三句话，不超过 ${L.tiers.mid.chars} 字）`);
    expect(applyMemoryBarOutput(full, tasks, output())).toEqual({
      ok: false,
      issues: ['要求压短记录 A，但 compress 里没有写'],
      stage: 'content',
      problems: ['compress_missing'],
    });
    expect(
      applyMemoryBarOutput(
        full,
        tasks,
        output({ compress: { A: '中'.repeat(L.tiers.mid.maxChars + 1) } })
      )
    ).toEqual({
      ok: false,
      issues: [`压短后的记录 A 太长，两三句话、不超过 ${L.tiers.mid.chars} 字`],
      stage: 'content',
      problems: ['compress_too_long'],
    });
    expect(tiersOf(grow(1, full))).toEqual(['mid', 'near', 'near', 'near', 'near']);
  });

  it('再往前挪进「远」压成一句话，挪出「远」的并进前情概要', () => {
    const state = grow(L.tiers.near.count + L.tiers.mid.count);
    const tasks = planMemoryBarUpdate(state, state.covered_turn + 3)!;
    expect(tasks.compress.map((t) => [t.key, t.index, t.to])).toEqual([
      ['A', 0, 'far'],
      ['B', L.tiers.mid.count, 'mid'],
    ]);
    const { user } = buildMemoryBarPromptMessages({
      systemPrompt: 'P',
      character: { name: '卡' },
      state,
      tasks,
      turns: [],
    });
    expect(user).toContain(`A（压成一句话，不超过 ${L.tiers.far.chars} 字）`);

    const last = grow(MEMORY_BAR_MAX_RECORDS);
    const folding = planMemoryBarUpdate(last, last.covered_turn + 3)!;
    expect(folding.fold?.records).toEqual([last.records[0]]);
    expect(
      applyMemoryBarOutput(
        last,
        folding,
        output({ compress: { A: '一句', B: '一句', C: '两三句' } })
      )
    ).toMatchObject({
      ok: false,
      issues: ['要求改写前情概要，但没有写 summary'],
    });
  });

  it('聊很久也封顶：近 4 段 / 中 6 段 / 远 12 段，更早的在前情概要里', () => {
    const state = grow(300);
    const count = (tier: string) => state.records.filter((r) => r.tier === tier).length;
    expect(MEMORY_BAR_TIERS.map(count)).toEqual(MEMORY_BAR_TIERS.map((t) => L.tiers[t].count));
    expect(tiersOf(state)).toEqual(
      [...tiersOf(state)].sort((a, b) => MEMORY_BAR_TIERS.indexOf(b) - MEMORY_BAR_TIERS.indexOf(a))
    );
    expect(state.milestones.length).toBeLessThanOrEqual(L.milestones);
    expect(state.summary).toContain('雨夜');
    expect(memoryBarChars(state)).toBeLessThanOrEqual(L.totalMaxChars);
  });

  it('每一部分都写到上限，整份也不超过 4000 字', () => {
    const maxed: GrowTexts = {
      record: (tasks) => `${tasks.fromTurn}`.padEnd(L.tiers.near.maxChars, '近'),
      milestone: (tasks) => `${tasks.fromTurn}`.padEnd(L.milestoneMaxChars, '碑'),
      mid: '中'.repeat(L.tiers.mid.maxChars),
      far: '远'.repeat(L.tiers.far.maxChars),
      summary: '概'.repeat(L.summaryMaxChars),
    };
    const state = grow(200, EMPTY_MEMORY_BAR, maxed);
    expect(memoryBarChars(state)).toBeGreaterThan(L.totalMaxChars * 0.8);
    // 最坏情况：每档放满、每段写到上限、里程碑放满
    const worst =
      MEMORY_BAR_TIERS.reduce((n, t) => n + L.tiers[t].count * L.tiers[t].maxChars, 0) +
      L.summaryMaxChars +
      L.milestones * L.milestoneMaxChars;
    expect(worst).toBeLessThanOrEqual(L.totalMaxChars);
    expect(memoryBarChars(state)).toBeLessThanOrEqual(L.totalMaxChars);
  });

  it('老会话第一次：旧记忆区原文整理进前情概要（没进展也要），从那条回复之后看起', () => {
    const tasks = planMemoryBarUpdate(EMPTY_MEMORY_BAR, 45, {
      text: '[memory]旧的记忆[/memory]',
      turn: 40,
    })!;
    expect(tasks).toMatchObject({ fromTurn: 41, toTurn: 45 });
    const { user } = buildMemoryBarPromptMessages({
      systemPrompt: 'P',
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
    expect(applyMemoryBarOutput(EMPTY_MEMORY_BAR, tasks, output({ record: '' })).ok).toBe(false);
    const result = applyMemoryBarOutput(
      EMPTY_MEMORY_BAR,
      tasks,
      output({ record: '', summary: '以前的事。' })
    );
    expect(result.ok && result.state).toMatchObject({ covered_turn: 40, summary: '以前的事。' });
  });
});

describe('记忆栏：分支继承', () => {
  it('继承来的记忆按分支编号整体平移；分支开头之前的记录 ≤ 0 也合法，之后从分支第 1 轮看起', () => {
    // 父会话记到第 40 轮；分支从父会话第 41 轮分出、只带 38–41 四轮，父会话第 40 轮是分支第 3 轮
    const inherited: MemoryBarState = {
      ...EMPTY_MEMORY_BAR,
      covered_turn: 40,
      milestones: [{ turn: 37, text: '林晚第一次说喜欢你' }],
      records: [
        { from_turn: 35, to_turn: 37, tier: 'near', text: record },
        { from_turn: 38, to_turn: 40, tier: 'near', text: record },
      ],
    };
    const rebased = rebaseMemoryBarState(inherited, 3);
    expect(rebased.covered_turn).toBe(3);
    expect(rebased.records.map((r) => [r.from_turn, r.to_turn])).toEqual([
      [-2, 0],
      [1, 3],
    ]);
    expect(rebased.milestones[0]?.turn).toBe(0);
    expect(MemoryBarStateSchema.safeParse(rebased).success).toBe(true);
    expect(rebaseMemoryBarState(inherited, 40)).toBe(inherited);

    // 锚点在分支开头之前：从分支第 1 轮看起
    const before = rebaseMemoryBarState(inherited, -5);
    expect(planMemoryBarUpdate(before, 1, null)?.fromTurn).toBe(1);
  });
});
