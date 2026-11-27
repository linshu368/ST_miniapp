/**
 * 档案超长时的两步兜底，只动「主线」板块（标题含「主线」的那个；默认模板是「一、故事主线」，
 * 生产 prompt v2 是「七、故事主线与约定」）：
 *   1. 把这个板块单独交给模型，只精简剧情经过，再拼回原位（输入小，模型更容易照字数做）；
 *   2. 还超就由程序按 T 编号从旧到新删掉这个板块里的剧情条目，直到全文不超过上限。
 * 按标题找而不是按位置：生产 prompt 的第一个板块是「亲密关系与进度」，写明了只能合并措辞、不得删除。
 * 板块里的伏笔、谜团、誓言、承诺、约定、仇怨、期限、长期任务，以及带「·用户」标注的条目，两步都不删
 * （prompt 规定永不删除 / 优先保护）。找不到主线板块就不动，按超长失败处理。
 * 2026-11-27 生产数据：整份档案交给模型「缩到 X 字」几乎原样返回（212 次成功 7 次），
 * 档案写满后每次重试都必然失败，同一段对话被反复压缩、章节在强制截断后丢失。纯函数，无 IO。
 */
import { countChars } from './text.js';
import { stripCodeFence } from './validate.js';

interface SectionSpan {
  heading: string;
  lines: string[];
  /** 主线板块正文的行区间 [start, end)，不含标题行 */
  start: number;
  end: number;
}

const FIRST_TURN_PATTERN = /[(（]T(\d+)/;
/** 剧情经过之外、不能被程序删掉的条目 */
const PROTECTED_ENTRY =
  /·用户|伏笔|谜|悬念|誓|承诺|约定|许诺|答应|仇|期限|倒计时|任务|尚未解决|未解决|未兑现/;

function plotSectionSpan(content: string, sections: string[]): SectionSpan | null {
  const heading = sections.find((section) => section.includes('主线'));
  if (!heading) return null;
  const lines = content.split(/\r?\n/);
  const headings = new Set(sections);
  const headingAt = lines.findIndex((line) => line.trim() === heading);
  if (headingAt < 0) return null;
  let end = lines.length;
  for (let index = headingAt + 1; index < lines.length; index += 1) {
    if (headings.has(lines[index]!.trim())) {
      end = index;
      break;
    }
  }
  return { heading, lines, start: headingAt + 1, end };
}

/** 主线板块的标题（去掉「## 」）与正文；没有主线板块时为 null */
export function plotSection(
  content: string,
  sections: string[]
): { title: string; body: string } | null {
  const span = plotSectionSpan(content, sections);
  if (!span) return null;
  return {
    title: span.heading.replace(/^##\s*/, ''),
    body: span.lines.slice(span.start, span.end).join('\n').trim(),
  };
}

/**
 * 用模型返回的板块正文替换主线板块。返回 null 表示输出不可用：空、含思考、
 * 混进了其他板块标题（说明模型改写了整份档案，拼回去会重复板块），
 * 或丢了、改了受保护的条目（伏笔、承诺、约定、·用户 等要求原样保留）。
 */
export function replacePlotSection(
  content: string,
  sections: string[],
  output: string
): string | null {
  const span = plotSectionSpan(content, sections);
  if (!span) return null;
  const headings = new Set(sections);
  const bodyLines = stripCodeFence(output)
    .split(/\r?\n/)
    .filter((line, index) => !(index === 0 && line.trim() === span.heading));
  const body = bodyLines.join('\n').trim();
  if (!body || /<\/?think(?:ing)?\b/i.test(body)) return null;
  if (bodyLines.some((line) => headings.has(line.trim()))) return null;
  const kept = new Set(bodyLines.map((line) => line.trim()));
  const protectedLines = span.lines
    .slice(span.start, span.end)
    .map((line) => line.trim())
    .filter((line) => FIRST_TURN_PATTERN.test(line) && PROTECTED_ENTRY.test(line));
  if (protectedLines.some((line) => !kept.has(line))) return null;
  return [...span.lines.slice(0, span.start), body, '', ...span.lines.slice(span.end)]
    .join('\n')
    .trim();
}

/**
 * 在主线板块里按每行最早的 T 编号从旧到新删剧情条目，直到全文不超过 maxChars。
 * 只删带 (T…) 标注、且不属于伏笔/承诺/约定等保护类的行；删完还超返回 null。
 */
export function trimPlotSection(
  content: string,
  sections: string[],
  maxChars: number
): { content: string; removed: number } | null {
  const span = plotSectionSpan(content, sections);
  if (!span) return null;
  const candidates = span.lines
    .map((line, index) => ({ index, line, turn: FIRST_TURN_PATTERN.exec(line)?.[1] }))
    .filter(
      (item): item is { index: number; line: string; turn: string } =>
        item.index >= span.start &&
        item.index < span.end &&
        item.turn !== undefined &&
        !PROTECTED_ENTRY.test(item.line)
    )
    .sort((a, b) => Number(a.turn) - Number(b.turn) || a.index - b.index);
  const removed = new Set<number>();
  let chars = countChars(content);
  for (const item of candidates) {
    if (chars <= maxChars) break;
    removed.add(item.index);
    chars -= countChars(item.line);
  }
  if (chars > maxChars) return null;
  return {
    content: span.lines.filter((_, index) => !removed.has(index)).join('\n'),
    removed: removed.size,
  };
}

/** 只精简主线板块的 prompt；措辞要求与主 prompt 一致（专有名词原样、保留 T 编号、不改成含糊说法） */
export function renderPlotShrinkPrompt(input: {
  title: string;
  body: string;
  targetChars: number;
}): string {
  return [
    `下面是一部长篇互动小说《前情档案》里「${input.title}」这一个板块，目前 ${countChars(input.body)} 字。请把它精简到 ${input.targetChars} 字以内（不计空白）后重新输出。`,
    '',
    '要求：',
    '1. 只精简剧情经过：越早的剧情越概括，多个早期事件合并成一句，只留下因果与结果；近期的关键事件保留「谁、在哪、做了什么、结果如何」。',
    '2. 尚未解决的伏笔、谜团、誓言、承诺、约定、仇怨、期限与长期任务，以及带「·用户」标注的条目，原样保留，不删、不改。',
    '3. 人名、地名、门派、物品、称号等专有名词原样保留，一字不改。',
    '4. 每条后面保留 (T编号) 标注，合并多条时标范围，例如 (T3-T20)。',
    '5. 保持原文的直白措辞，不淡化、不改成含糊说法，不添加原文没有的信息。',
    '6. 只输出这个板块的正文，不要输出板块标题、其他板块、解释或代码块。',
    '',
    '【板块原文】',
    input.body,
  ].join('\n');
}
