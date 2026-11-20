/**
 * 模板语义校验：在结构合法（StatusBarTemplateDraftSchema）之上，检查"能不能拿去用"。
 * 发布角色卡、保存玩家覆盖版、喂状态模型之前都要过这里；编辑器用同一函数实时提示。
 */
import { statusDefinitionChars } from './definition';
import {
  STATUS_BAR_LIMITS,
  STATUS_FILL_BLANK,
  countStatusBarItems,
  type StatusBarItem,
  type StatusBarTemplate,
} from './schema';
import { isListStyle, STATUS_BAR_SPEC, statusValueMatches } from './spec';
import { STATUS_EMPTY_VALUE } from './parse';

export type StatusBarIssueCode =
  | 'NO_ITEMS'
  | 'EMPTY_SECTION'
  | 'TOO_MANY_ITEMS'
  | 'DUPLICATE_NAME'
  | 'REPEAT_TITLE_REQUIRED'
  | 'SECTION_TITLE_CONFLICT'
  | 'MISSING_PARAM'
  | 'DESC_MISSING'
  | 'DESC_TOO_SHORT'
  | 'DESC_UNFILLED'
  | 'DESC_ONLY_NAME'
  | 'DESC_NO_DIRECTION'
  | 'INIT_MISMATCH'
  | 'DEFINITION_TOO_LONG';

export interface StatusBarIssue {
  code: StatusBarIssueCode;
  /** 指向哪一项（没有就是整栏的问题）。 */
  itemId?: string;
  message: string;
}

const chars = (value: string) => [...value].length;
// 涨跌两个方向的常见说法（模型常写"累积、获得、消耗、扣除、清零"等，都要认）。
const UP = /涨|升|加|增|多|高|累积|积累|获得|赚|收入|奖励|恢复|补充|充值|攀/;
const DOWN =
  /掉|降|减|少|低|回落|消耗|扣|跌|削弱|清零|归零|流失|衰减|滑|花费|花掉|支出|损失|丢|退|用掉|耗/;

function checkParams(item: StatusBarItem): string | null {
  if (item.style === 'bar' && !item.max) return '进度条要设上限';
  if (item.style === 'stars' && !item.total) return '星级要设满星数';
  if (item.style === 'stage') {
    const list = item.stages ?? [];
    if (list.length < STATUS_BAR_LIMITS.stagesMin) return '阶段至少要列 2 个';
    if (new Set(list).size !== list.length) return '阶段名不能重复';
  }
  return null;
}

function checkDesc(item: StatusBarItem): StatusBarIssue | null {
  const desc = item.desc.trim();
  const at = { itemId: item.id };
  if (!desc)
    return {
      code: 'DESC_MISSING',
      ...at,
      message: `「${item.name}」还没写说明：这是什么、怎么变。不写模型不知道这一项该写什么`,
    };
  if (chars(desc) < STATUS_BAR_LIMITS.descMinChars)
    return {
      code: 'DESC_TOO_SHORT',
      ...at,
      message: `「${item.name}」的说明太短（至少 ${STATUS_BAR_LIMITS.descMinChars} 个字）：再写清这是什么、怎么变`,
    };
  if (desc.includes(STATUS_FILL_BLANK))
    return { code: 'DESC_UNFILLED', ...at, message: `「${item.name}」的说明还有空没填（___）` };
  if (desc.replace(/[\s：:。，,.]/g, '') === item.name)
    return {
      code: 'DESC_ONLY_NAME',
      ...at,
      message: `「${item.name}」的说明只重复了名称，写清它是什么、怎么变`,
    };
  if (
    (item.style === 'bar' || item.style === 'percent' || item.style === 'number') &&
    !(UP.test(desc) && DOWN.test(desc))
  )
    return {
      code: 'DESC_NO_DIRECTION',
      ...at,
      message: `「${item.name}」是数值，说明里要写清什么情况涨、什么情况掉`,
    };
  if (item.style === 'stars' && !(UP.test(desc) && DOWN.test(desc)))
    return {
      code: 'DESC_NO_DIRECTION',
      ...at,
      message: `「${item.name}」是星级，说明里要写清什么情况加星、什么情况减星`,
    };
  return null;
}

/** 返回全部问题；空数组表示可以用。 */
export function checkStatusBarTemplate(template: StatusBarTemplate): StatusBarIssue[] {
  const issues: StatusBarIssue[] = [];
  const total = countStatusBarItems(template);
  if (total === 0) issues.push({ code: 'NO_ITEMS', message: '状态栏里还没有任何项目' });
  if (total > STATUS_BAR_LIMITS.items)
    issues.push({ code: 'TOO_MANY_ITEMS', message: `最多 ${STATUS_BAR_LIMITS.items} 项` });
  const names = new Map<string, number>();
  const fixedTitles = new Set<string>();
  for (const section of template.sections) {
    if (section.items.length === 0 && template.sections.length > 1)
      issues.push({
        code: 'EMPTY_SECTION',
        message: `分区「${section.title || '无标题'}」里还没有项目`,
      });
    if (section.repeat && !section.title.trim())
      issues.push({
        code: 'REPEAT_TITLE_REQUIRED',
        message: '每人一组的分区要写占位名，比如"人物名"',
      });
    if (!section.repeat && section.title) {
      if (fixedTitles.has(section.title))
        issues.push({
          code: 'SECTION_TITLE_CONFLICT',
          message: `分区标题「${section.title}」重复了`,
        });
      fixedTitles.add(section.title);
    }
    for (const item of section.items) {
      names.set(item.name, (names.get(item.name) ?? 0) + 1);
      const param = checkParams(item);
      if (param)
        issues.push({
          code: 'MISSING_PARAM',
          itemId: item.id,
          message: `「${item.name}」：${param}`,
        });
      const desc = checkDesc(item);
      if (desc) issues.push(desc);
      const init = item.init?.trim();
      const initOk =
        !init ||
        param ||
        (isListStyle(item.style)
          ? init === STATUS_EMPTY_VALUE || initListOk(item, init)
          : statusValueMatches(item, init));
      if (!initOk)
        issues.push({
          code: 'INIT_MISMATCH',
          itemId: item.id,
          message: `「${item.name}」的开局值要写成：${STATUS_BAR_SPEC[item.style].initHint(item)}`,
        });
    }
  }
  for (const [name, count] of names)
    if (count > 1)
      issues.push({
        code: 'DUPLICATE_NAME',
        message: `项目名「${name}」重复了，每一项要叫不同的名字`,
      });
  if (total > 0 && statusDefinitionChars(template) > STATUS_BAR_LIMITS.definitionMaxChars)
    issues.push({
      code: 'DEFINITION_TOO_LONG',
      message: '状态栏写得太多了：删掉一些项目，或把说明写短一点',
    });
  return issues;
}

/** 清单类开局值：每行都要是 [x]/[ ] 或 "- " 开头的一条。 */
function initListOk(item: StatusBarItem, init: string): boolean {
  const lines = init
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  if (item.style === 'checks')
    return lines.every((line) => /^(?:[-*•][ \t]{0,3})?\[[ xX✓√]?\][ \t]{0,3}\S/.test(line));
  if (item.style === 'bullets') return lines.every((line) => /^[-*•·][ \t]{1,3}\S/.test(line));
  return false;
}
