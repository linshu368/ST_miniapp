/**
 * 状态模型输出的校验与规范化。
 *
 * - 按模板逐项检查：名称在不在、写法对不对得上样式（spec.ts 同源）。
 * - 缺的项、写歪的项由代码沿用上次记录的值（只是不变，不算变化量）。
 * - 输出按模板顺序写回规范文本存库；下一次更新把它当"上次记录的状态"喂回模型。
 */
import {
  extractStatusBlock,
  parseStatusBody,
  serializeStatusSections,
  STATUS_EMPTY_VALUE,
  type StatusEntry,
  type StatusSection,
} from './parse';
import type { StatusBarItem, StatusBarSection, StatusBarTemplate } from './schema';
import { isListStyle, STATUS_BAR_SPEC, statusValueMatches } from './spec';

export type StatusOutcome = 'ok' | 'partial' | 'failed';

export interface StatusValidation {
  outcome: StatusOutcome;
  /** 给重试用的问题清单（中文短句）。 */
  issues: string[];
  /** 规范文本；outcome=failed 时为 null。 */
  text: string | null;
  expectedCount: number;
  matchedCount: number;
}

type ItemLines = StatusEntry[];

/** 把一个分区的条目按项目名切开：名称行 + 紧跟的清单条目归到同一项。 */
function groupByItem(section: StatusSection | undefined): Map<string, ItemLines> {
  const out = new Map<string, ItemLines>();
  if (!section) return out;
  let current: ItemLines | null = null;
  for (const entry of section.entries) {
    if (entry.kind === 'field' || entry.kind === 'label') {
      const name = entry.kind === 'field' ? entry.label : entry.text;
      current = [entry];
      if (!out.has(name)) out.set(name, current);
    } else if ((entry.kind === 'check' || entry.kind === 'bullet') && current) {
      current.push(entry);
    }
  }
  return out;
}

function itemOk(item: StatusBarItem, lines: ItemLines): boolean {
  const head = lines[0];
  if (!head) return false;
  if (isListStyle(item.style)) {
    if (head.kind === 'field') return head.raw === STATUS_EMPTY_VALUE;
    const want = item.style === 'checks' ? 'check' : 'bullet';
    return lines.slice(1).every((line) => line.kind === want);
  }
  return head.kind === 'field' && statusValueMatches(item, head.raw);
}

interface SectionResult {
  entries: StatusEntry[];
  matched: number;
  issues: string[];
  carried: boolean;
}

function checkItems(
  items: StatusBarItem[],
  found: Map<string, ItemLines>,
  previous: Map<string, ItemLines>,
  where: string
): SectionResult {
  const result: SectionResult = { entries: [], matched: 0, issues: [], carried: false };
  for (const item of items) {
    const lines = found.get(item.name);
    if (lines && itemOk(item, lines)) {
      result.entries.push(...lines);
      result.matched += 1;
      continue;
    }
    result.issues.push(
      lines
        ? `${where}「${item.name}」写法不对，应为：${STATUS_BAR_SPEC[item.style].format(item)}`
        : `${where}缺了「${item.name}」`
    );
    const fallback = previous.get(item.name);
    result.entries.push(
      ...(fallback ?? [
        {
          kind: 'field',
          label: item.name,
          raw: STATUS_EMPTY_VALUE,
          value: { kind: 'text', text: STATUS_EMPTY_VALUE, wide: false },
        },
      ])
    );
    result.carried = true;
  }
  return result;
}

/** 输出里的分区按模板对号入座：无标题 → 第一个无标题分区；固定标题 → 同名；其余有标题的都算"每人一组"。 */
function bucketSections(template: StatusBarTemplate, sections: StatusSection[]) {
  const fixed = new Map<string, StatusSection>();
  const groups: StatusSection[] = [];
  let untitled: StatusSection | undefined;
  const fixedTitles = new Set(
    template.sections.filter((s) => !s.repeat && s.title).map((s) => s.title)
  );
  for (const section of sections) {
    if (!section.title) untitled = untitled ?? section;
    else if (fixedTitles.has(section.title))
      fixed.set(section.title, fixed.get(section.title) ?? section);
    else groups.push(section);
  }
  return { fixed, groups, untitled };
}

function validateTemplate(
  template: StatusBarTemplate,
  sections: StatusSection[],
  previousSections: StatusSection[]
): StatusValidation {
  const now = bucketSections(template, sections);
  const before = bucketSections(template, previousSections);
  const out: StatusSection[] = [];
  const issues: string[] = [];
  let matched = 0;
  let expected = 0;
  let carried = false;
  const repeatSection = template.sections.find(
    (s): s is StatusBarSection & { repeat: NonNullable<StatusBarSection['repeat']> } =>
      s.repeat !== null
  );
  for (const section of template.sections) {
    if (section.repeat) continue;
    const found = groupByItem(section.title ? now.fixed.get(section.title) : now.untitled);
    const prev = groupByItem(section.title ? before.fixed.get(section.title) : before.untitled);
    const r = checkItems(section.items, found, prev, section.title ? `【${section.title}】` : '');
    out.push({ title: section.title || null, entries: r.entries });
    issues.push(...r.issues);
    matched += r.matched;
    expected += section.items.length;
    carried ||= r.carried;
  }
  if (repeatSection) {
    // 开局文本里的【人物名】只是占位，不能当成真人沿用下去。
    before.groups = before.groups.filter((g) => g.title !== repeatSection.title);
    if (now.groups.some((g) => g.title === repeatSection.title))
      issues.push(`要把「${repeatSection.title}」换成真实名字`);
    const groups = (now.groups.length ? now.groups : before.groups).slice(
      0,
      repeatSection.repeat.max
    );
    if (now.groups.length > repeatSection.repeat.max)
      issues.push(`【${repeatSection.title}】最多 ${repeatSection.repeat.max} 组`);
    if (!now.groups.length && before.groups.length) carried = true;
    for (const group of groups) {
      const prevGroup = before.groups.find((g) => g.title === group.title);
      const r = checkItems(
        repeatSection.items,
        groupByItem(group),
        groupByItem(prevGroup),
        `【${group.title}】`
      );
      out.push({ title: group.title, entries: r.entries });
      issues.push(...r.issues);
      matched += now.groups.length ? r.matched : 0;
      expected += repeatSection.items.length;
      carried ||= r.carried;
    }
  }
  if (matched === 0)
    return {
      outcome: 'failed',
      issues: issues.length ? issues : ['没有可用的项目'],
      text: null,
      expectedCount: expected,
      matchedCount: 0,
    };
  return {
    outcome: issues.length || carried ? 'partial' : 'ok',
    issues,
    text: serializeStatusSections(out.filter((s) => s.entries.length)),
    expectedCount: expected,
    matchedCount: matched,
  };
}

/**
 * @param template 生效模板；null 表示自动（只检查是不是规范的行语法）
 * @param output 模型原始输出
 * @param previousText 上次记录的规范文本（或开局文本），用来沿用缺失项
 */
export function validateStatusOutput(
  template: StatusBarTemplate | null,
  output: string,
  previousText: string | null
): StatusValidation {
  const parsed = parseStatusBody(extractStatusBlock(output));
  if (parsed.format === 'legacy')
    return {
      outcome: 'failed',
      issues: ['用了旧格式（<details>），要改成每行「名称：内容」'],
      text: null,
      expectedCount: 0,
      matchedCount: 0,
    };
  const strayLines = parsed.noteCount ? [`有 ${parsed.noteCount} 行不是「名称：内容」`] : [];
  if (!template) {
    if (parsed.fieldCount === 0)
      return {
        outcome: 'failed',
        issues: ['没有可用的项目'],
        text: null,
        expectedCount: 0,
        matchedCount: 0,
      };
    return {
      outcome: strayLines.length ? 'partial' : 'ok',
      issues: strayLines,
      text: serializeStatusSections(parsed.sections),
      expectedCount: parsed.fieldCount,
      matchedCount: parsed.fieldCount,
    };
  }
  const previous = previousText ? parseStatusBody(previousText) : null;
  const result = validateTemplate(
    template,
    parsed.sections,
    previous?.format === 'v2' ? previous.sections : []
  );
  if (strayLines.length && result.outcome === 'ok')
    return { ...result, outcome: 'partial', issues: strayLines };
  return { ...result, issues: [...result.issues, ...strayLines] };
}
