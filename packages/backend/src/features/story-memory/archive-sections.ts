/**
 * 档案篇幅控制（11-27 第三版，用户定方案 A）。纯函数，无 IO。
 *
 * 为什么由程序算数字：关思考后模型对「近期 30 轮」「超过八成先腾地方」这类要自己算的抽象规则基本不执行
 * （prompt v3 上线后，旧档案过八成时每次反而平均涨 1860 字），但会照着写好的具体数字做。
 * 所以每次并入都在 prompt 末尾附上按本次数据算好的轮次分层和字数上限；超长时带上各板块字数和压缩目标再并一次。
 *
 * 用户定的原则：
 *   - 标题含「亲密」「偏好」「要求」的板块只能新增或更新，不得删减——程序检查：不得少于旧档案的 90%；
 *   - 剧情板块（人物 / 主线 / 世界观 / 存疑）随时间逐步简化，越早越概括；
 *   - 方案 A：剧情压完仍超时，「持续状态」「主角现状」也可以合并措辞，但仍然生效的内容一条不能少；
 *   - 不由程序删条目；第一版的逐板块精简 54 次 0 成功，已去掉。
 * 板块按标题关键词找，不按位置：生产 prompt v2 起第一个板块是亲密关系。
 */
import { countChars } from './text.js';

const GUARDED_SECTION = /亲密|偏好|要求/;
const PLOT_SECTION = /人物|主线|世界观|存疑/;
const STATE_SECTION = /持续状态|主角/;
/** 守护板块不得少于旧档案的这个比例（合并措辞允许小幅变短） */
export const GUARDED_MIN_RATIO = 0.9;
/** 旧档案里太短的守护板块不检查：几十字的板块改一句话就会误判 */
const GUARDED_MIN_OLD_CHARS = 200;
/** 旧档案达到目标字数的这个比例，本次不得净增长 */
const NEAR_FULL_RATIO = 0.8;
/** 未接近上限时，每次并入允许的增长 = 新章节字数 × 这个比例 */
const GROWTH_RATIO = 0.1;
/** 超长重试时剧情板块最多压到原来的 60%，状态板块最多压到 80% */
const PLOT_FLOOR = 0.6;
const STATE_FLOOR = 0.8;
const RECENT_TURNS = 30;
const EARLY_AFTER_TURNS = 80;

const title = (heading: string) => heading.replace(/^##\s*/, '');
const quote = (headings: string[]) => headings.map((heading) => `「${title(heading)}」`).join('');

/** 每个板块正文的字数（不含标题行）；找不到的板块记 0 */
export function sectionSizes(content: string, sections: string[]): Map<string, number> {
  const headings = new Set(sections);
  const sizes = new Map(sections.map((heading) => [heading, 0]));
  let current: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (headings.has(trimmed)) {
      current = trimmed;
      continue;
    }
    if (current) sizes.set(current, sizes.get(current)! + countChars(trimmed));
  }
  return sizes;
}

/** 守护板块（亲密 / 偏好 / 要求）比旧档案少了 10% 以上的第一个；没有就返回 null */
export function guardedShrink(
  oldMemory: string | null,
  output: string,
  sections: string[]
): { heading: string; before: number; after: number } | null {
  if (!oldMemory) return null;
  const before = sectionSizes(oldMemory, sections);
  const after = sectionSizes(output, sections);
  for (const heading of sections) {
    if (!GUARDED_SECTION.test(heading)) continue;
    const old = before.get(heading)!;
    const now = after.get(heading)!;
    if (old >= GUARDED_MIN_OLD_CHARS && now < old * GUARDED_MIN_RATIO) {
      return { heading, before: old, after: now };
    }
  }
  return null;
}

/** 本次输出的字数上限：没接近上限时允许按新章节的十分之一增长；接近上限时不得净增长 */
export function mergeBudget(input: {
  oldChars: number;
  historyChars: number;
  targetChars: number;
}): number {
  const { oldChars, historyChars, targetChars } = input;
  if (oldChars >= targetChars * NEAR_FULL_RATIO) return Math.min(oldChars, targetChars);
  return Math.min(targetChars, oldChars + Math.ceil(historyChars * GROWTH_RATIO));
}

function tierLine(nowTurn: number): string {
  const recentFrom = Math.max(1, nowTurn - RECENT_TURNS + 1);
  const parts = [`现在是 T${nowTurn}。剧情分层：近期 T${recentFrom}–T${nowTurn} 写具体`];
  if (recentFrom > 1) {
    const middleFrom = Math.max(1, nowTurn - EARLY_AFTER_TURNS + 1);
    parts.push(`中期 T${middleFrom}–T${recentFrom - 1} 每件事一句`);
    if (middleFrom > 1) parts.push(`早期 T1–T${middleFrom - 1} 按阶段合并，每个阶段一到两句`);
  }
  return `- ${parts.join('；')}。`;
}

function groups(sections: string[]) {
  return {
    plot: sections.filter(
      (heading) => PLOT_SECTION.test(heading) && !GUARDED_SECTION.test(heading)
    ),
    state: sections.filter(
      (heading) => STATE_SECTION.test(heading) && !GUARDED_SECTION.test(heading)
    ),
    guarded: sections.filter((heading) => GUARDED_SECTION.test(heading)),
  };
}

/** 每次并入都附在 prompt 末尾的篇幅要求（程序按本次数据算好的具体数字） */
export function renderMergeBudget(input: {
  sections: string[];
  nowTurn: number;
  oldChars: number;
  budgetChars: number;
  targetChars: number;
}): string {
  const { plot, state, guarded } = groups(input.sections);
  const lines = ['【本次整理的篇幅要求】（程序按本次数据算好的，照做）', tierLine(input.nowTurn)];
  if (input.oldChars === 0) {
    lines.push(`- 本次输出的整份档案不超过 ${input.budgetChars} 字（不计空白）。`);
  } else {
    lines.push(
      `- 旧档案 ${input.oldChars} 字。本次输出的整份档案不超过 ${input.budgetChars} 字（不计空白）。`
    );
  }
  if (input.oldChars >= input.targetChars * NEAR_FULL_RATIO) {
    lines.push(
      `- 旧档案已接近上限，本次不得净增长：先把${quote(plot)}里的中期条目改成一事一句、早期条目按阶段合并，` +
        (state.length ? `再把${quote(state)}合并措辞（仍然生效的规则、状态一条不能少），` : '') +
        '腾出的字数用来并入新章节。'
    );
  }
  if (guarded.length) lines.push(`- ${quote(guarded)}只能新增或更新，不得删减。`);
  return lines.join('\n');
}

/**
 * 并入超长后的再并一次：告诉模型上次各板块多少字、每个板块压到多少。
 * 先从剧情板块按大小分摊（每个不低于 60%），不够再分给状态板块（每个不低于 80%）；守护板块不分。
 */
export function renderOverflowRetry(input: {
  sections: string[];
  output: string;
  maxChars: number;
  targetChars: number;
}): string {
  const { plot, state, guarded } = groups(input.sections);
  const sizes = sectionSizes(input.output, input.sections);
  const total = countChars(input.output);
  let need = Math.max(0, total - input.targetChars);
  const caps = new Map<string, number>();
  for (const [headings, floor] of [
    [plot, PLOT_FLOOR],
    [state, STATE_FLOOR],
  ] as const) {
    const room = headings.reduce((sum, heading) => sum + sizes.get(heading)! * (1 - floor), 0);
    if (need <= 0 || room <= 0) continue;
    const share = Math.min(1, need / room);
    for (const heading of headings) {
      const size = sizes.get(heading)!;
      const cut = Math.ceil(size * (1 - floor) * share);
      if (cut > 0) caps.set(heading, size - cut);
    }
    need -= Math.min(need, room);
  }
  const lines = [
    `【上次输出超长】上次整份 ${total} 字，超过上限 ${input.maxChars} 字。这次整份不超过 ${input.targetChars} 字。`,
  ];
  for (const [heading, cap] of caps) {
    lines.push(`- ${quote([heading])}上次 ${sizes.get(heading)} 字，这次压到 ${cap} 字以内。`);
  }
  lines.push(
    '- 剧情板块按上面的分层合并早期和中期内容；状态板块只合并措辞，仍然生效的内容一条不能少。'
  );
  if (guarded.length) lines.push(`- ${quote(guarded)}一字不删，只能新增或更新。`);
  return lines.join('\n');
}
