/**
 * 状态模型输出的校验与规范化。
 *
 * - 按模板逐项检查：名称在不在、写法对不对得上样式（spec.ts 同源）。
 * - 缺的项、写歪的项由代码沿用上次记录的值（只是不变，不算变化量）。
 * - 输出按模板顺序写回规范文本存库；下一次更新把它当"上次记录的状态"喂回模型。
 * - 逐项给出最终显示结果（items）和这次停在哪一层（stage），供质量监控统计；不影响校验结论。
 * - 每人一组的分区：标题默认是占位名（如【人物名】），要求换成真名；作者直接写了真名的（角色资料里出现过），
 *   照写就对，也能沿用上次记录（见 statusRepeatTitleIsName）。
 */
import {
  extractStatusBlock,
  parseStatusBody,
  serializeStatusSections,
  STATUS_EMPTY_VALUE,
  type StatusEntry,
  type StatusSection,
} from './parse';
import type { StatusBarItem, StatusBarSection, StatusBarStyle, StatusBarTemplate } from './schema';
import { isListStyle, STATUS_BAR_SPEC, statusValueMatches, statusValueRenders } from './spec';

export type StatusOutcome = 'ok' | 'partial' | 'failed';

/**
 * 一项在面板上的最终结果：
 * - fresh：本次写对，且按样式的组件显示；
 * - empty：本次写的是"暂无"（提示词允许，单列统计，不算失败）；
 * - kind_mismatch：写法通过校验，但面板会显示成别的组件；
 * - carried：缺失或写错，沿用上次的值（没有上次就补"暂无"）。
 */
export type StatusItemResult = 'fresh' | 'empty' | 'kind_mismatch' | 'carried';

export interface StatusItemOutcome {
  style: StatusBarStyle;
  result: StatusItemResult;
}

/** 这次输出停在哪一层：format 认不出是状态栏；content 认出了但没全对上；ok 全对上。 */
export type StatusValidationStage = 'format' | 'content' | 'ok';

/** 没过检查的原因（只有类型和数量，不含内容），用于日志统计。 */
export interface StatusProblems {
  missing: number;
  /** 写法不对的项各自的样式 */
  badFormat: StatusBarStyle[];
  /** 没把占位名换成真名的组数 */
  placeholderTitle: number;
  /** 超出组数上限、被丢掉的组数 */
  extraGroups: number;
  /** 不是「名称：内容」的行数 */
  strayLines: number;
}

export interface StatusValidateOptions {
  /** 每人一组分区的标题就是真名（作者写的真名，不是占位名） */
  repeatTitleIsName?: boolean;
}

const noProblems = (): StatusProblems => ({
  missing: 0,
  badFormat: [],
  placeholderTitle: 0,
  extraGroups: 0,
  strayLines: 0,
});

/**
 * 每人一组分区的标题是不是真名：标题在角色资料（名字、简介）里出现过，就当作者写的真名。
 * 占位名（人物名、在场的她……）一般不会原样出现在资料里；万一误判，代价只是模型照抄占位名时不再被要求改。
 */
export function statusRepeatTitleIsName(template: StatusBarTemplate, material: string): boolean {
  const title = template.sections.find((section) => section.repeat)?.title.trim() ?? '';
  return [...title].length >= 2 && material.includes(title);
}

export interface StatusValidation {
  outcome: StatusOutcome;
  /** 给重试用的问题清单（中文短句）。 */
  issues: string[];
  /** 规范文本；outcome=failed 时为 null。 */
  text: string | null;
  expectedCount: number;
  matchedCount: number;
  problems: StatusProblems;
  stage: StatusValidationStage;
  /** 逐项结果（每人一组按组展开；一组都没有时按一组算沿用）。 */
  items: StatusItemOutcome[];
}

/** 一次都没对上（模型没出结果、格式认不出）时，面板上每一项都是沿用。 */
export function statusCarriedItems(template: StatusBarTemplate): StatusItemOutcome[] {
  return template.sections.flatMap((section) =>
    section.items.map((item) => ({ style: item.style, result: 'carried' as const }))
  );
}

/** 写对的项在面板上的样子：暂无单列；其余看组件对不对得上样式。 */
function freshResult(item: StatusBarItem, lines: ItemLines): StatusItemResult {
  const head = lines[0];
  const raw = head?.kind === 'field' ? head.raw.trim() : '';
  if (raw === STATUS_EMPTY_VALUE) return 'empty';
  if (isListStyle(item.style)) return 'fresh';
  return statusValueRenders(item, raw) ? 'fresh' : 'kind_mismatch';
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
  items: StatusItemOutcome[];
}

function checkItems(
  items: StatusBarItem[],
  found: Map<string, ItemLines>,
  previous: Map<string, ItemLines>,
  where: string,
  problems: StatusProblems,
  /** found 其实是上次的记录（这次一组都没写）：对得上也只是沿用 */
  stale = false
): SectionResult {
  const result: SectionResult = { entries: [], matched: 0, issues: [], carried: false, items: [] };
  for (const item of items) {
    const lines = found.get(item.name);
    if (lines && itemOk(item, lines)) {
      result.entries.push(...lines);
      result.matched += 1;
      result.items.push({
        style: item.style,
        result: stale ? 'carried' : freshResult(item, lines),
      });
      continue;
    }
    result.items.push({ style: item.style, result: 'carried' });
    if (lines) problems.badFormat.push(item.style);
    else problems.missing += 1;
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
  previousSections: StatusSection[],
  options: StatusValidateOptions,
  problems: StatusProblems
): StatusValidation {
  const now = bucketSections(template, sections);
  const before = bucketSections(template, previousSections);
  const out: StatusSection[] = [];
  const issues: string[] = [];
  const items: StatusItemOutcome[] = [];
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
    const r = checkItems(
      section.items,
      found,
      prev,
      section.title ? `【${section.title}】` : '',
      problems
    );
    out.push({ title: section.title || null, entries: r.entries });
    issues.push(...r.issues);
    items.push(...r.items);
    matched += r.matched;
    expected += section.items.length;
    carried ||= r.carried;
  }
  if (repeatSection) {
    // 占位名（【人物名】）不能当成真人沿用下去，也要求换成真名；作者直接写的真名照写就对。
    if (!options.repeatTitleIsName) {
      before.groups = before.groups.filter((g) => g.title !== repeatSection.title);
      problems.placeholderTitle = now.groups.filter((g) => g.title === repeatSection.title).length;
      if (problems.placeholderTitle) issues.push(`要把「${repeatSection.title}」换成真实名字`);
    }
    const groups = (now.groups.length ? now.groups : before.groups).slice(
      0,
      repeatSection.repeat.max
    );
    if (now.groups.length > repeatSection.repeat.max) {
      problems.extraGroups = now.groups.length - repeatSection.repeat.max;
      issues.push(`【${repeatSection.title}】最多 ${repeatSection.repeat.max} 组`);
    }
    if (!now.groups.length && before.groups.length) carried = true;
    for (const group of groups) {
      const prevGroup = before.groups.find((g) => g.title === group.title);
      const r = checkItems(
        repeatSection.items,
        groupByItem(group),
        groupByItem(prevGroup),
        `【${group.title}】`,
        problems,
        !now.groups.length
      );
      out.push({ title: group.title, entries: r.entries });
      issues.push(...r.issues);
      items.push(...r.items);
      matched += now.groups.length ? r.matched : 0;
      expected += repeatSection.items.length;
      carried ||= r.carried;
    }
    // 这次没写、上次也没有：面板上这一块是空的，按一组沿用计
    if (!groups.length)
      items.push(
        ...repeatSection.items.map((item) => ({ style: item.style, result: 'carried' as const }))
      );
  }
  if (matched === 0)
    return {
      outcome: 'failed',
      issues: issues.length ? issues : ['没有可用的项目'],
      text: null,
      expectedCount: expected,
      matchedCount: 0,
      problems,
      stage: 'content',
      items,
    };
  const outcome = issues.length || carried ? 'partial' : 'ok';
  return {
    outcome,
    issues,
    text: serializeStatusSections(out.filter((s) => s.entries.length)),
    expectedCount: expected,
    matchedCount: matched,
    problems,
    stage: outcome === 'ok' ? 'ok' : 'content',
    items,
  };
}

/**
 * @param template 生效模板（玩家改过的或卡自带的）
 * @param output 模型原始输出
 * @param previousText 上次记录的规范文本（或开局文本），用来沿用缺失项
 * @param options.repeatTitleIsName 每人一组分区的标题是真名（statusRepeatTitleIsName 判断）
 */
export function validateStatusOutput(
  template: StatusBarTemplate,
  output: string,
  previousText: string | null,
  options: StatusValidateOptions = {}
): StatusValidation {
  const parsed = parseStatusBody(extractStatusBlock(output));
  const problems = noProblems();
  if (parsed.format === 'legacy')
    return {
      outcome: 'failed',
      issues: ['用了旧格式（<details>），要改成每行「名称：内容」'],
      text: null,
      expectedCount: 0,
      matchedCount: 0,
      problems,
      stage: 'format',
      items: statusCarriedItems(template),
    };
  problems.strayLines = parsed.noteCount;
  const strayLines = parsed.noteCount ? [`有 ${parsed.noteCount} 行不是「名称：内容」`] : [];
  const previous = previousText ? parseStatusBody(previousText) : null;
  const result = validateTemplate(
    template,
    parsed.sections,
    previous?.format === 'v2' ? previous.sections : [],
    options,
    problems
  );
  // 一行"名称：内容"都没有（整段散文、空输出）：认不出是状态栏，算格式层失败
  const stage = parsed.fieldCount === 0 ? 'format' : result.stage;
  if (strayLines.length && result.outcome === 'ok')
    return { ...result, outcome: 'partial', issues: strayLines, stage: 'content' };
  return { ...result, issues: [...result.issues, ...strayLines], stage };
}
