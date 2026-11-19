import { describe, expect, it } from 'vitest';
import { parseStatusBody, parseStatusValue, serializeStatusSections } from '../status-bar';

const kind = (value: string) => parseStatusValue(value).kind;

describe('状态栏 v2 解析：值的类型只看写法', () => {
  it.each([
    ['68/100', 'bar'],
    ['68/100（+3）', 'bar'],
    ['６８／１００ （＋３）', 'bar'],
    ['120/100', 'bar'],
    ['45%', 'percent'],
    ['45%（-10%）', 'percent'],
    ['45％', 'percent'],
    ['★★★☆☆', 'stars'],
    ['⭐⭐⭐', 'stars'],
    ['暧昧（3/5）', 'stage'],
    ['筑基期(2/9)', 'stage'],
    ['1200金币（-300）', 'number'],
    ['1200 金币', 'number'],
    ['3天', 'number'],
    ['26岁', 'number'],
    ['1200', 'number'],
    ['-15（-5）', 'number'],
    ['紧张、害羞、期待', 'tags'],
    ['白衬衫｜黑丝｜高跟鞋', 'tags'],
    ['微醺', 'text'],
    ['26', 'text'],
    ['23:40', 'text'],
    ['5/0', 'text'],
    ['她想起了海边、旧照片，还有那首歌', 'text'],
    ['68/100，因为你夸了她', 'text'],
    ['（3/5）', 'text'],
  ])('%s → %s', (value, expected) => {
    expect(kind(value)).toBe(expected);
  });

  it('数值细节', () => {
    expect(parseStatusValue('暧昧（3/5）')).toEqual({
      kind: 'stage',
      label: '暧昧',
      step: 3,
      total: 5,
    });
    expect(parseStatusValue('-5/100')).toMatchObject({ kind: 'bar', bucket: 0 });
    expect(parseStatusValue('120/100')).toMatchObject({ kind: 'bar', bucket: 100 });
    expect(parseStatusValue('45%（-10%）')).toMatchObject({ kind: 'percent', delta: -10 });
    expect(parseStatusValue('68/100（+3）')).toMatchObject({ delta: 3 });
    expect(parseStatusValue('1200金币（-300）')).toMatchObject({ unit: '金币', delta: -300 });
  });
});

describe('状态栏 v2 解析：整段', () => {
  it('分区、清单、列表、跑偏写法', () => {
    const r = parseStatusBody(`- **时间**: 深夜
1. 地点：客厅
## 💗林晚
* 好感度 ： ６８／１００ （＋３）
步骤：
[x] 混进晚宴
- [ ] 打开保险柜
☐ 安全离开
【背包】
- 书房钥匙`);
    expect(r.format).toBe('v2');
    if (r.format !== 'v2') return;
    expect(r.sections.map((s) => s.title)).toEqual([null, '💗林晚', '背包']);
    expect(r.sections[1]!.entries.map((e) => e.kind)).toEqual([
      'field',
      'label',
      'check',
      'check',
      'check',
    ]);
    expect(r.noteCount).toBe(0);
  });

  it('旧格式交给旧解析器', () => {
    expect(
      parseStatusBody('<details><summary>人物</summary>\n```markdown\n好感：1\n```\n</details>')
        .format
    ).toBe('legacy');
  });

  it('散文与带冒号的句子不当字段', () => {
    const r = parseStatusBody('她转身离开了房间，留下一句话。\n之后的故事，她笑着说：“你来啦。”');
    expect(r.format === 'v2' && r.noteCount).toBe(2);
  });

  it('骨架里没填的占位行被忽略', () => {
    const r = parseStatusBody('步骤：\n[ ] \n物品：\n- ');
    expect(r.format === 'v2' && r.noteCount).toBe(0);
  });

  it('HTML 只当文字', () => {
    const r = parseStatusBody('心情：<b onclick=x>开心</b>');
    expect(r.format === 'v2' && r.sections[0]!.entries[0]).toMatchObject({
      kind: 'field',
      raw: '<b onclick=x>开心</b>',
    });
  });

  it('规范写回再解析结果不变', () => {
    const text =
      '时间：深夜\n【林晚】\n好感：44/100（+4）\n想和你做的事：\n[x] 一起喝一杯\n[ ] 留下来过夜\n旧物：\n- 白衬衫';
    const first = parseStatusBody(text);
    if (first.format !== 'v2') throw new Error('legacy');
    expect(serializeStatusSections(first.sections)).toBe(text);
  });

  it('恶意输入都在 50ms 内', () => {
    const inputs = [
      ' '.repeat(200000),
      '\n'.repeat(200000),
      ('好感度：' + ' '.repeat(5000) + '1').repeat(50),
      ('【' + 'a'.repeat(5000)).repeat(20),
      ('1'.repeat(10000) + '/').repeat(20),
      ('**' + '*'.repeat(10000)).repeat(10),
      '# ' + '#'.repeat(20000),
      ('好感度：(+' + ' '.repeat(3000) + '\n').repeat(80),
      ('[x]' + ' '.repeat(3000) + '\n').repeat(80),
      ('阶段：' + '（'.repeat(3000) + '\n').repeat(80),
      ('标签：' + '、'.repeat(3000) + '\n').repeat(80),
      ('- ' + ' '.repeat(3000) + 'a\n').repeat(80),
    ];
    for (const input of inputs) {
      const start = performance.now();
      parseStatusBody(input);
      expect(performance.now() - start).toBeLessThan(50);
    }
  });
});
