/**
 * 档案超过上限时的轻压：只压生产 prompt 允许压的板块，按它规定的顺序，一次一个板块，回到上限以内就停。
 * 用户 2026-11-27 定的原则：
 *   - 没超上限就不干涉（这里的函数只在并入结果超长时用）；
 *   - 只压超出的部分：每个板块的目标 = max(原来的 60%，原来 − 超出量)，模型返回少于原来一半就作废；
 *   - 标题含「亲密」「偏好」「要求」的板块永远不动（prompt 规定只能合并措辞、不得删除）；
 *   - 板块里的伏笔、谜团、誓言、承诺、约定、仇怨、期限、长期任务和带「·用户」的条目必须原样保留；
 *   - 不由程序删条目。
 * 板块按标题关键词找，不按位置：生产 prompt v2 的第一个板块是亲密关系，第一版按位置选错过（已回退）。
 * 纯函数，无 IO。
 */
import { countChars } from './text.js';
import { stripCodeFence } from './validate.js';

/** 压缩顺序（生产 prompt：早期剧情合并 → 世界观与次要伏笔 → 次要人物精简） */
const SHRINK_ORDER: ReadonlyArray<RegExp> = [/主线/, /世界观|存疑/, /人物/];
/** 永远不动的板块 */
const PROTECTED_SECTION = /亲密|偏好|要求/;
/** 板块里必须原样保留的条目 */
const PROTECTED_ENTRY =
  /·用户|伏笔|谜|悬念|誓|承诺|约定|许诺|答应|仇|期限|倒计时|任务|尚未解决|未解决|未兑现/;
const TURN_LABEL = /[(（]T\d+/;
/** 一次最多压到原来的这个比例；模型返回低于 MIN_KEEP_RATIO 作废 */
export const SECTION_TARGET_RATIO = 0.6;
const MIN_KEEP_RATIO = 0.5;

interface SectionSpan {
  heading: string;
  lines: string[];
  /** 板块正文的行区间 [start, end)，不含标题行 */
  start: number;
  end: number;
}

function sectionSpan(content: string, sections: string[], heading: string): SectionSpan | null {
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

/** 按压缩顺序列出可压的板块标题（同一标题只出现一次；含保护关键词的跳过） */
export function shrinkableSections(sections: string[]): string[] {
  const ordered: string[] = [];
  for (const pattern of SHRINK_ORDER) {
    for (const heading of sections) {
      if (pattern.test(heading) && !PROTECTED_SECTION.test(heading) && !ordered.includes(heading)) {
        ordered.push(heading);
      }
    }
  }
  return ordered;
}

export function sectionBody(content: string, sections: string[], heading: string): string | null {
  const span = sectionSpan(content, sections, heading);
  return span ? span.lines.slice(span.start, span.end).join('\n').trim() : null;
}

/** 目标：只压超出的部分，且不低于原来的 60% */
export function sectionTarget(bodyChars: number, overflowChars: number): number {
  return Math.max(Math.ceil(bodyChars * SECTION_TARGET_RATIO), bodyChars - overflowChars);
}

/**
 * 用模型返回的正文替换指定板块。返回 null 表示输出不可用：空、含思考、混进其他板块标题、
 * 少于原来的一半，或丢了 / 改了必须原样保留的条目。
 */
export function replaceSection(
  content: string,
  sections: string[],
  heading: string,
  output: string
): string | null {
  const span = sectionSpan(content, sections, heading);
  if (!span) return null;
  const headings = new Set(sections);
  const original = span.lines.slice(span.start, span.end);
  const bodyLines = stripCodeFence(output)
    .split(/\r?\n/)
    .filter((line, index) => !(index === 0 && line.trim() === heading));
  const body = bodyLines.join('\n').trim();
  if (!body || /<\/?think(?:ing)?\b/i.test(body)) return null;
  if (bodyLines.some((line) => headings.has(line.trim()))) return null;
  if (countChars(body) < countChars(original.join('\n')) * MIN_KEEP_RATIO) return null;
  const kept = new Set(bodyLines.map((line) => line.trim()));
  const mustKeep = original
    .map((line) => line.trim())
    .filter((line) => TURN_LABEL.test(line) && PROTECTED_ENTRY.test(line));
  if (mustKeep.some((line) => !kept.has(line))) return null;
  return [...span.lines.slice(0, span.start), body, '', ...span.lines.slice(span.end)]
    .join('\n')
    .trim();
}

/** 只精简一个板块的 prompt；措辞要求与主 prompt 一致（专有名词原样、保留 T 编号、不改成含糊说法） */
export function renderSectionShrinkPrompt(input: {
  title: string;
  body: string;
  targetChars: number;
}): string {
  return [
    `下面是一部长篇互动小说《前情档案》里「${input.title}」这一个板块，目前 ${countChars(input.body)} 字。请把它精简到大约 ${input.targetChars} 字（不计空白），不要少于这个字数太多。`,
    '',
    '要求：',
    '1. 优先合并早期、次要的内容：多个早期事件合并成一句，只留下因果与结果；次要人物精简为一句；近期和重要的内容保持具体。',
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
