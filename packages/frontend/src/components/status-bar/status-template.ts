/**
 * 编辑器用的模板工具：预览取值、生成 id、替换项目或分区。规则全部来自 shared（spec / check），
 * 编辑器允许的写法和状态模型提示词、解析器是同一套。
 */
import {
  STATUS_BAR_SPEC,
  checkStatusBarTemplate,
  isListStyle,
  type StatusBarIssue,
  type StatusBarItem,
  type StatusBarSection,
  type StatusBarTemplate,
} from '@miniapp/shared';

export const newStatusId = (prefix: 'i' | 's') =>
  `${prefix}-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)}`;

export function emptyStatusTemplate(): StatusBarTemplate {
  return {
    version: 1,
    note: '',
    sections: [{ id: newStatusId('s'), title: '', repeat: null, items: [] }],
  };
}

/** 预览里这一项显示什么：有开局值用开局值，没有就用样式的示例写法。 */
export function previewItemText(item: StatusBarItem): string {
  const value = item.init?.trim() || STATUS_BAR_SPEC[item.style].example(item);
  return isListStyle(item.style)
    ? `${item.name || '名称'}：\n${value}`
    : `${item.name || '名称'}：${value}`;
}

export function replaceItem(
  template: StatusBarTemplate,
  sectionId: string,
  item: StatusBarItem,
  isNew: boolean
): StatusBarTemplate {
  return {
    ...template,
    sections: template.sections.map((section) =>
      section.id !== sectionId
        ? section
        : {
            ...section,
            items: isNew
              ? [...section.items, item]
              : section.items.map((x) => (x.id === item.id ? item : x)),
          }
    ),
  };
}

export function removeItem(template: StatusBarTemplate, itemId: string): StatusBarTemplate {
  return {
    ...template,
    sections: template.sections.map((section) => ({
      ...section,
      items: section.items.filter((x) => x.id !== itemId),
    })),
  };
}

export function replaceSection(
  template: StatusBarTemplate,
  section: StatusBarSection,
  isNew: boolean
): StatusBarTemplate {
  return {
    ...template,
    sections: isNew
      ? [...template.sections, section]
      : template.sections.map((x) => (x.id === section.id ? section : x)),
  };
}

export function removeSection(template: StatusBarTemplate, sectionId: string): StatusBarTemplate {
  return { ...template, sections: template.sections.filter((x) => x.id !== sectionId) };
}

/** 保存一项之前：只拿和这一项相关的问题（加整栏层面的总量、重名问题）。 */
export function issuesForItem(template: StatusBarTemplate, itemId: string): StatusBarIssue[] {
  return checkStatusBarTemplate(template).filter(
    (issue) =>
      issue.itemId === itemId ||
      issue.code === 'DUPLICATE_NAME' ||
      issue.code === 'DEFINITION_TOO_LONG' ||
      issue.code === 'TOO_MANY_ITEMS'
  );
}
