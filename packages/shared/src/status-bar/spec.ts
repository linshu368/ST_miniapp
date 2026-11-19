/**
 * 样式规格：每种样式"提示词怎么教 / 骨架怎么写 / 合法值长什么样 / 解析器怎么认 / 玩家填空模板"
 * 只在这里定义一次。提示词（prompt.ts）、模板语义校验（check.ts）、输出校验（validate.ts）、
 * 编辑器提示都从这里取，避免"界面允许的、提示词教的、解析器认的"三者对不上。
 * __tests__/status-bar-consistency.test.ts 逐样式对账。
 */
import { parseStatusValue, STATUS_EMPTY_VALUE, type StatusValue } from './parse';
import type { StatusBarItem, StatusBarStyle } from './schema';

interface StyleSpec {
  /** 提示词里的样式写法（"进度条，写成 当前值/100"）。 */
  format: (item: StatusBarItem) => string;
  /** 骨架里冒号后的预填（进度条预填 /100，百分比预填 %）。 */
  skeleton: (item: StatusBarItem) => string;
  /** 清单类在名称行下面放的占位行。 */
  listMarker?: '[ ] ' | '- ';
  /** 一个按 format 写出来的合法值，用于示例、预览占位和对账测试。 */
  example: (item: StatusBarItem) => string;
  /** 解析器认这个值是不是这个样式（含模板参数：上限、满星数、阶段列表）。 */
  accepts: (item: StatusBarItem, value: StatusValue) => boolean;
  /** 编辑器里"说明"的写法提示。 */
  descHint: string;
  /** 说明的填空模板（玩家点一下插入，只填 ___）。 */
  fillTemplate: string;
  /** "开局时"输入框的占位提示。 */
  initHint: (item: StatusBarItem) => string;
}

const barMax = (item: StatusBarItem) => item.max ?? 100;
const starTotal = (item: StatusBarItem) => item.total ?? 5;
const stages = (item: StatusBarItem) => item.stages ?? [];

export const STATUS_BAR_SPEC: Record<StatusBarStyle, StyleSpec> = {
  bar: {
    format: (item) => `进度条，写成 当前值/${barMax(item)}`,
    skeleton: (item) => `/${barMax(item)}`,
    example: (item) => `${Math.round(barMax(item) * 0.3)}/${barMax(item)}`,
    accepts: (item, value) => value.kind === 'bar' && value.max === barMax(item),
    descHint: '写清：这是什么；什么情况涨、什么情况掉；一轮最多变多少。',
    fillTemplate: '她对你的___。___时会涨，___时会掉，每轮最多变___。',
    initHint: (item) => `比如 ${Math.round(barMax(item) * 0.3)}/${barMax(item)}`,
  },
  percent: {
    format: () => '百分比，写成 数字%',
    skeleton: () => '%',
    example: () => '45%',
    accepts: (_item, value) => value.kind === 'percent',
    descHint: '写清：这是什么；什么情况涨、什么情况降；到多少会怎样。',
    fillTemplate: '她此刻___的程度。___时会涨，___时会降，到___%时会___。',
    initHint: () => '比如 30%',
  },
  stars: {
    format: (item) => `星级，用★和☆一共写${starTotal(item)}个`,
    skeleton: () => '',
    example: (item) => '★★' + '☆'.repeat(Math.max(0, starTotal(item) - 2)),
    accepts: (item, value) => value.kind === 'stars' && value.total === starTotal(item),
    descHint: '写清：这是什么；什么情况加星、什么情况减星；满星会怎样。',
    fillTemplate: '___的高低。___时加星，___时减星，满星时___。',
    initHint: (item) => `比如 ${'★★' + '☆'.repeat(Math.max(0, starTotal(item) - 2))}`,
  },
  number: {
    format: (item) => (item.unit ? `数字，写成 数字${item.unit}` : '数字'),
    skeleton: () => '',
    example: (item) => `120${item.unit ?? ''}`,
    // 无单位时 "26" 这类两位数会被解析成文字，这里一并放行，避免误判模型写错。
    accepts: (_item, value) =>
      value.kind === 'number' || (value.kind === 'text' && /^-?\d+(\.\d+)?$/.test(value.text)),
    descHint: '写清：数的是什么；什么时候增加、什么时候减少。',
    fillTemplate: '___的数量。___时增加，___时减少。',
    initHint: (item) => `比如 100${item.unit ?? ''}`,
  },
  line: {
    format: () => '一句话',
    skeleton: () => '',
    example: () => '她家客厅的沙发上',
    accepts: (_item, value) => value.kind !== 'empty',
    descHint: '写清：这一项写什么、写多细，什么时候要更新。',
    fillTemplate: '她此刻的___，写清楚___，有变化就更新。',
    initHint: () => '开局时的样子',
  },
  tags: {
    format: () => '标签，几个词用、隔开',
    skeleton: () => '',
    example: () => '紧张、期待',
    accepts: (_item, value) => value.kind === 'tags' || value.kind === 'text',
    descHint: '写清：写哪一类词、几个，举两三个例子。',
    fillTemplate: '她此刻的___，写___个词，比如___。',
    initHint: () => '比如 好奇、拘谨',
  },
  para: {
    format: () => '一段话',
    skeleton: () => '',
    example: () => '他要是再靠近一点，我就不躲了。',
    accepts: (_item, value) => value.kind !== 'empty',
    descHint: '写清：写什么、用谁的口吻、第几人称。',
    fillTemplate: '她此刻___，用___的口吻、第一人称写一两句。',
    initHint: () => '开局时的一段话',
  },
  stage: {
    format: (item) =>
      `阶段，从 ${stages(item).join('→')} 里选一个，写成 阶段名（第几/${stages(item).length}）`,
    skeleton: () => '',
    example: (item) => `${stages(item)[0] ?? '阶段'}（1/${stages(item).length}）`,
    accepts: (item, value) =>
      value.kind === 'stage' &&
      value.total === stages(item).length &&
      stages(item)[value.step - 1] === value.label,
    descHint: '写清：这是什么；剧情里发生什么才往前走一格；会不会倒退。',
    fillTemplate: '你们现在的___。剧情里___了才往前走一格，___（会/不会）倒退。',
    initHint: (item) =>
      `比如 ${stages(item)[0] ?? '陌生'}（1/${Math.max(2, stages(item).length)}）`,
  },
  checks: {
    format: () => '打勾清单，名称单独一行，下面每条一行，完成写 [x]，没完成写 [ ]',
    skeleton: () => '',
    listMarker: '[ ] ',
    example: () => '[x] 已经做到的事\n[ ] 还没做的事',
    accepts: () => true,
    descHint: '写清：列什么、几条、什么算完成。',
    fillTemplate: '她想和你___的事，列___条，做到了就打勾。',
    initHint: () => '每行一条，[x] 已完成 / [ ] 未完成',
  },
  bullets: {
    format: () => '列表，名称单独一行，下面每条一行，以「- 」开头',
    skeleton: () => '',
    listMarker: '- ',
    example: () => '- 第一样\n- 第二样',
    accepts: () => true,
    descHint: '写清：列什么、什么时候加、什么时候删。',
    fillTemplate: '她___的东西，每样一行，有新的就加上，没了就删掉。',
    initHint: () => '每行一条，以 - 开头',
  },
};

export const isListStyle = (style: StatusBarStyle) => style === 'checks' || style === 'bullets';
/** 会写变化量（+3）的样式。 */
export const isDeltaStyle = (style: StatusBarStyle) =>
  style === 'bar' || style === 'percent' || style === 'number';

/** 单个值是否符合这一项的样式；"暂无"永远合法（提示词约定"没信息写暂无"）。 */
export function statusValueMatches(item: StatusBarItem, raw: string): boolean {
  const text = raw.trim();
  if (text === STATUS_EMPTY_VALUE) return true;
  return STATUS_BAR_SPEC[item.style].accepts(item, parseStatusValue(text));
}
