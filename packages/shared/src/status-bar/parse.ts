/**
 * 状态栏 v2 行语法解析。纯函数、无 IO，前后端共用。
 *
 * 每行独立判断：一行写歪只退化成"备注行"，不连累其他行。所有正则都锚定单行、量词有界、
 * 无嵌套量词，逐行执行，不存在跨行回溯；整段最多 80 行、每行截到 300 字。
 * 值的类型只看写法本身（68/100 是进度条、45% 是百分比、暧昧（3/5）是阶段），
 * 不依赖模板，所以模板改了、删了，历史状态照样能显示。知道这一项的样式时，面板按 spec.ts 的
 * statusDisplayValue 显示（同一段文本在不同样式下该是不同组件）。
 */

export type StatusValue =
  | { kind: 'bar'; current: number; max: number; delta: number | null; bucket: number }
  | { kind: 'percent'; current: number; delta: number | null; bucket: number }
  | { kind: 'stars'; filled: number; total: number }
  | { kind: 'stage'; label: string; step: number; total: number }
  | { kind: 'number'; current: number; unit: string | null; delta: number | null }
  | { kind: 'tags'; tags: string[] }
  | { kind: 'text'; text: string; wide: boolean }
  | { kind: 'empty' };

export type StatusEntry =
  | {
      kind: 'field';
      label: string;
      value: StatusValue;
      /** 冒号后的原文（已去首尾空白），用于原样回写。 */ raw: string;
    }
  | { kind: 'label'; text: string }
  | { kind: 'check'; done: boolean; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'note'; text: string };

export interface StatusSection {
  title: string | null;
  entries: StatusEntry[];
}

export type ParsedStatus =
  | { format: 'legacy' }
  | { format: 'v2'; sections: StatusSection[]; fieldCount: number; noteCount: number };

export const STATUS_MAX_LINES = 80;
export const STATUS_MAX_LINE_CHARS = 300;
/** 文字值超过这个长度就整行显示（短的两列排）。 */
export const STATUS_WIDE_TEXT_CHARS = 12;
/** "没信息写暂无"——提示词里的约定，任何样式写成它都算合法。 */
export const STATUS_EMPTY_VALUE = '暂无';

const PUNCT = '，。！？；、“”"\'…,.!?;';
const NAME = `[^：:【】\\[\\]<>\\r\\n${PUNCT}]`;
const SECTION = /^(?:【([^【】[\]<>\r\n]{1,20})】|#{1,4}[ \t]{0,3}([^#\r\n]{1,20}))$/;
const CHECK = /^(?:[-*•][ \t]{0,3})?(?:\[([ xX✓√])\]|([☑✅✔☐□⬜✗✘]))[ \t]{0,3}(\S.{0,200})$/;
const BULLET = /^[-*•·][ \t]{1,3}(\S.{0,200})$/;
const ORDINAL = /^\d{1,2}[.、)）][ \t]{0,3}/;
const BOLD = /^\*\*([^*]{1,40})\*\*/;
const FIELD = new RegExp(`^(${NAME}{1,12})[：:][ \\t]{0,3}(.{0,280})$`);
const PLACEHOLDER_LINE = /^(?:[-*•·]|\[[ xX]?\]|[☐□⬜])$/;
const FENCE_LINE = /^(?:`{3,}|~{3,})/;

const SIGNED = '[+-][ \\t]{0,2}\\d{1,6}(?:\\.\\d{1,2})?';
const DELTA = `(?:[ \\t]{0,2}[（(][ \\t]{0,2}(${SIGNED})(%?)[ \\t]{0,2}[)）])?`;
const BAR = new RegExp(`^(-?\\d{1,6}(?:\\.\\d{1,2})?)[ \\t]{0,2}\\/[ \\t]{0,2}(\\d{1,6})${DELTA}$`);
const PERCENT = new RegExp(`^(-?\\d{1,3}(?:\\.\\d{1,2})?)%${DELTA}$`);
const STARS = /^([★⭐]{0,10})([☆]{0,10})$/u;
const STAGE =
  /^([^\d（()）\r\n][^（()）\r\n]{0,11})[ \t]{0,2}[（(][ \t]{0,2}(\d{1,2})[ \t]{0,2}\/[ \t]{0,2}(\d{1,2})[ \t]{0,2}[)）]$/;
const NUMBER = new RegExp(
  `^(-?\\d{1,9}(?:\\.\\d{1,2})?)[ \\t]{0,2}([^\\d\\s（()）${PUNCT}：:]{0,4})${DELTA}$`
);
const TAG_SPLIT = /[、｜|]/;
const SENTENCE = /[，。！？；…,.!?;]/;

const chars = (value: string) => [...value].length;

function normalizeDigits(value: string): string {
  return value
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/／/g, '/')
    .replace(/％/g, '%')
    .replace(/＋/g, '+')
    .replace(/[－−—]/g, '-');
}

const toDelta = (sign: string | undefined) =>
  sign === undefined ? null : Number(sign.replace(/\s/g, ''));
/** 进度按 5% 取整，前端用 21 档宽度渲染。 */
const bucket = (ratio: number) => Math.round(Math.min(1, Math.max(0, ratio)) * 20) * 5;

export function parseStatusValue(raw: string): StatusValue {
  const text = raw.trim();
  if (!text) return { kind: 'empty' };
  const value = normalizeDigits(text);
  let m: RegExpExecArray | null;
  if ((m = BAR.exec(value)) && Number(m[2]) > 0) {
    const current = Number(m[1]);
    const max = Number(m[2]);
    return { kind: 'bar', current, max, delta: toDelta(m[3]), bucket: bucket(current / max) };
  }
  if ((m = PERCENT.exec(value))) {
    const current = Number(m[1]);
    return { kind: 'percent', current, delta: toDelta(m[2]), bucket: bucket(current / 100) };
  }
  if ((m = STARS.exec(value)) && m[0].length > 0 && chars(m[0]) <= 10) {
    return { kind: 'stars', filled: chars(m[1] ?? ''), total: chars(m[0]) };
  }
  if ((m = STAGE.exec(value))) {
    const step = Number(m[2]);
    const total = Number(m[3]);
    if (total >= 2 && total <= 10 && step >= 1 && step <= total) {
      return { kind: 'stage', label: (m[1] ?? '').trim(), step, total };
    }
  }
  if ((m = NUMBER.exec(value)) && (m[2] || m[3] !== undefined || /^\d{3,}$/.test(m[1] ?? ''))) {
    return { kind: 'number', current: Number(m[1]), unit: m[2] || null, delta: toDelta(m[3]) };
  }
  const pieces = text.split(TAG_SPLIT).map((piece) => piece.trim());
  if (
    pieces.length >= 2 &&
    pieces.length <= 12 &&
    !SENTENCE.test(text) &&
    pieces.every((piece) => piece && chars(piece) <= 10)
  ) {
    return { kind: 'tags', tags: pieces };
  }
  return { kind: 'text', text, wide: chars(text) > STATUS_WIDE_TEXT_CHARS };
}

function parseLine(raw: string): StatusEntry | { kind: 'section'; title: string } | null {
  let line = raw.trim().slice(0, STATUS_MAX_LINE_CHARS);
  if (!line || FENCE_LINE.test(line) || PLACEHOLDER_LINE.test(line)) return null;
  let m: RegExpExecArray | null;
  if ((m = SECTION.exec(line))) return { kind: 'section', title: (m[1] ?? m[2] ?? '').trim() };
  if ((m = CHECK.exec(line))) {
    const mark = m[1] ?? m[2] ?? '';
    return { kind: 'check', done: /[xX✓√☑✅✔]/.test(mark), text: (m[3] ?? '').trim() };
  }
  line = line.replace(ORDINAL, '');
  const bulletless = line.replace(/^[-*•·][ \t]{1,3}/, '');
  const bold = BOLD.exec(bulletless);
  const candidate = bold ? (bold[1] ?? '') + bulletless.slice(bold[0].length) : bulletless;
  if ((m = FIELD.exec(candidate))) {
    const label = (m[1] ?? '').trim();
    const raw = (m[2] ?? '').trim();
    const value = parseStatusValue(raw);
    return value.kind === 'empty'
      ? { kind: 'label', text: label }
      : { kind: 'field', label, value, raw };
  }
  if ((m = BULLET.exec(line))) return { kind: 'bullet', text: (m[1] ?? '').trim() };
  return { kind: 'note', text: line };
}

/** 解析 [status]…[/status] 之间的正文；含 <details> 的旧格式交给旧解析器。 */
export function parseStatusBody(body: string): ParsedStatus {
  if (/<\/?(?:details|summary)\b/i.test(body)) return { format: 'legacy' };
  const sections: StatusSection[] = [{ title: null, entries: [] }];
  let section = sections[0]!;
  for (const raw of body.split(/\r?\n/).slice(0, STATUS_MAX_LINES)) {
    const parsed = parseLine(raw);
    if (!parsed) continue;
    if (parsed.kind === 'section') {
      section = { title: parsed.title, entries: [] };
      sections.push(section);
      continue;
    }
    section.entries.push(parsed);
  }
  const kept = sections.filter((item) => item.entries.length > 0);
  const count = (kind: StatusEntry['kind']) =>
    kept.reduce((n, item) => n + item.entries.filter((entry) => entry.kind === kind).length, 0);
  return {
    format: 'v2',
    sections: kept,
    fieldCount: count('field') + count('check') + count('bullet') + count('label'),
    noteCount: count('note'),
  };
}

/**
 * 从模型输出里取出状态栏正文：有 [status] 就取标签之间（缺结尾取到末尾），
 * 没有就当整段都是正文。模型偶尔会把整块包进代码围栏，围栏行在解析时会被忽略。
 */
export function extractStatusBlock(output: string): string {
  const open = output.indexOf('[status]');
  if (open < 0) return output;
  const start = open + '[status]'.length;
  const close = output.indexOf('[/status]', start);
  return close < 0 ? output.slice(start) : output.slice(start, close);
}

/** 把解析结果按规范写法写回文本（丢掉备注行）。存库和喂下一次模型都用这个规范文本。 */
export function serializeStatusSections(sections: StatusSection[]): string {
  const lines: string[] = [];
  for (const section of sections) {
    if (section.title) lines.push(`【${section.title}】`);
    for (const entry of section.entries) {
      if (entry.kind === 'field') lines.push(`${entry.label}：${entry.raw}`);
      else if (entry.kind === 'label') lines.push(`${entry.text}：`);
      else if (entry.kind === 'check') lines.push(`${entry.done ? '[x]' : '[ ]'} ${entry.text}`);
      else if (entry.kind === 'bullet') lines.push(`- ${entry.text}`);
    }
  }
  return lines.join('\n');
}
