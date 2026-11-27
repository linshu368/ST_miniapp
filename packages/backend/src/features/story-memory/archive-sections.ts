/**
 * 档案超长时的两步兜底，只动第一个板块（默认 prompt 里是「一、故事主线」）：
 *   1. 把这一个板块单独交给模型压到目标字数，再拼回原位（输入小，模型更容易照字数做）；
 *   2. 还超就由程序按 T 编号从旧到新删掉这个板块里的整条，直到全文不超过上限。
 * 2026-11-27 生产数据：整份档案交给模型「缩到 X 字」几乎原样返回（212 次成功 7 次），
 * 档案写满后每次重试都必然失败，同一段对话被反复压缩、章节在强制截断后丢失。
 * 其余板块（人物、主角现状、世界观、伏笔、存疑、用户要求）一字不动。纯函数，无 IO。
 */
import { countChars } from './text.js';
import { stripCodeFence } from './validate.js';

interface SectionSpan {
  lines: string[];
  /** 第一个板块正文的行区间 [start, end)，不含标题行 */
  start: number;
  end: number;
}

function leadSectionSpan(content: string, sections: string[]): SectionSpan | null {
  const lead = sections[0];
  if (!lead) return null;
  const lines = content.split(/\r?\n/);
  const headings = new Set(sections);
  const headingAt = lines.findIndex((line) => line.trim() === lead);
  if (headingAt < 0) return null;
  let end = lines.length;
  for (let index = headingAt + 1; index < lines.length; index += 1) {
    if (headings.has(lines[index]!.trim())) {
      end = index;
      break;
    }
  }
  return { lines, start: headingAt + 1, end };
}

/** 第一个板块的标题（去掉「## 」）与正文；找不到时为 null */
export function leadSection(
  content: string,
  sections: string[]
): { title: string; body: string } | null {
  const span = leadSectionSpan(content, sections);
  if (!span) return null;
  return {
    title: sections[0]!.replace(/^##\s*/, ''),
    body: span.lines.slice(span.start, span.end).join('\n').trim(),
  };
}

/**
 * 用模型返回的板块正文替换第一个板块。返回 null 表示输出不可用：空、含思考、
 * 或混进了其他板块标题（说明模型改写了整份档案，拼回去会重复板块）。
 */
export function replaceLeadSection(
  content: string,
  sections: string[],
  output: string
): string | null {
  const span = leadSectionSpan(content, sections);
  if (!span) return null;
  const headings = new Set(sections);
  const bodyLines = stripCodeFence(output)
    .split(/\r?\n/)
    .filter((line, index) => !(index === 0 && line.trim() === sections[0]));
  const body = bodyLines.join('\n').trim();
  if (!body || /<\/?think(?:ing)?\b/i.test(body)) return null;
  if (bodyLines.some((line) => headings.has(line.trim()))) return null;
  return [...span.lines.slice(0, span.start), body, '', ...span.lines.slice(span.end)]
    .join('\n')
    .trim();
}

const FIRST_TURN_PATTERN = /[(（]T(\d+)/;

/**
 * 在第一个板块里按每行最早的 T 编号从旧到新删整行，直到全文不超过 maxChars。
 * 只删带 (T…) 标注的条目行；删光了还超（其他板块本身就超）返回 null。
 */
export function trimLeadSection(
  content: string,
  sections: string[],
  maxChars: number
): { content: string; removed: number } | null {
  const span = leadSectionSpan(content, sections);
  if (!span) return null;
  const candidates = span.lines
    .map((line, index) => ({ index, turn: FIRST_TURN_PATTERN.exec(line)?.[1] }))
    .filter(
      (item): item is { index: number; turn: string } =>
        item.index >= span.start && item.index < span.end && item.turn !== undefined
    )
    .sort((a, b) => Number(a.turn) - Number(b.turn) || a.index - b.index);
  const removed = new Set<number>();
  let chars = countChars(content);
  for (const item of candidates) {
    if (chars <= maxChars) break;
    removed.add(item.index);
    chars -= countChars(span.lines[item.index]!);
  }
  if (chars > maxChars) return null;
  return {
    content: span.lines.filter((_, index) => !removed.has(index)).join('\n'),
    removed: removed.size,
  };
}

/** 只精简第一个板块的 prompt；措辞要求与主 prompt 一致（专有名词原样、保留 T 编号、不改成含糊说法） */
export function renderLeadSectionShrinkPrompt(input: {
  title: string;
  body: string;
  targetChars: number;
}): string {
  return [
    `下面是一部长篇互动小说《前情档案》里「${input.title}」这一个板块，目前 ${countChars(input.body)} 字。请把它精简到 ${input.targetChars} 字以内（不计空白）后重新输出。`,
    '',
    '要求：',
    '1. 越早的剧情越概括：多个早期事件合并成一句，只留下因果与结果；近期的关键事件保留「谁、在哪、做了什么、结果如何」。',
    '2. 人名、地名、门派、物品、称号等专有名词原样保留，一字不改。',
    '3. 每条后面保留 (T编号) 标注，合并多条时标范围，例如 (T3-T20)。',
    '4. 保持原文的直白措辞，不淡化、不改成含糊说法，不添加原文没有的信息。',
    '5. 只输出这个板块的正文，不要输出板块标题、其他板块、解释或代码块。',
    '',
    '【板块原文】',
    input.body,
  ].join('\n');
}
