/**
 * 由模板生成的三段文本：输出骨架、状态栏定义块（喂给状态模型）、开局状态（面板初始显示 / 第一次更新的起点）。
 */
import { STATUS_EMPTY_VALUE } from './parse';
import type { StatusBarItem, StatusBarSection, StatusBarTemplate } from './schema';
import { isListStyle, STATUS_BAR_SPEC } from './spec';

function itemLines(item: StatusBarItem, value: string | null): string[] {
  const spec = STATUS_BAR_SPEC[item.style];
  if (isListStyle(item.style)) {
    const body = value?.trim();
    return [
      `${item.name}：`,
      ...(body
        ? body
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
        : [spec.listMarker ?? '']),
    ];
  }
  return [`${item.name}：${value?.trim() ?? spec.skeleton(item)}`];
}

/** 每人一组的分区，骨架里用分区标题作占位名（如【人物名】），模型换成真实名字。 */
function sectionHeader(section: StatusBarSection): string | null {
  return section.title ? `【${section.title}】` : null;
}

/** 输出骨架（不含开局值）。 */
export function statusSkeletonText(template: StatusBarTemplate): string {
  const lines = ['[status]'];
  for (const section of template.sections) {
    const header = sectionHeader(section);
    if (header) lines.push(header);
    for (const item of section.items) lines.push(...itemLines(item, null));
  }
  lines.push('[/status]');
  return lines.join('\n');
}

export function repeatSectionRule(section: StatusBarSection): string | null {
  if (!section.repeat) return null;
  return `【${section.title}】这一组：每个${section.repeat.what}各写一组，最多${section.repeat.max}组，把「${section.title}」换成真实名字。`;
}

/** 【状态栏定义】块：整体说明 + 输出骨架 + 每人一组规则 + 每项"样式写法：说明"。 */
export function statusDefinitionText(template: StatusBarTemplate): string {
  const lines = ['【状态栏定义】'];
  if (template.note.trim()) lines.push(`整体：${template.note.trim()}`);
  lines.push('输出骨架：', statusSkeletonText(template));
  for (const section of template.sections) {
    const rule = repeatSectionRule(section);
    if (rule) lines.push(rule);
  }
  lines.push('各项：');
  for (const section of template.sections) {
    for (const item of section.items) {
      lines.push(
        `- ${item.name}（${STATUS_BAR_SPEC[item.style].format(item)}）：${item.desc.trim()}`
      );
    }
  }
  return lines.join('\n');
}

/**
 * 开局状态：有开局值的写开局值，没有的写"暂无"（数值类按样式给不出合理起点，交给模型第一次更新时定）。
 * 用作面板在第一次更新之前的显示，以及第一次更新时"上次记录的状态"。
 */
export function statusInitialText(template: StatusBarTemplate): string {
  const lines: string[] = [];
  for (const section of template.sections) {
    const header = sectionHeader(section);
    if (header) lines.push(header);
    for (const item of section.items) {
      const init = item.init?.trim();
      lines.push(...(init ? itemLines(item, init) : [`${item.name}：${STATUS_EMPTY_VALUE}`]));
    }
  }
  return lines.join('\n');
}

/** 定义块长度（≤1200 的那个上限按它算）。 */
export function statusDefinitionChars(template: StatusBarTemplate): number {
  return [...statusDefinitionText(template)].length;
}
