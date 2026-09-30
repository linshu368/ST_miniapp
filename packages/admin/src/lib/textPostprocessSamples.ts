import {
  TEXT_POSTPROCESS_POLICY_VERSION,
  TEXT_POSTPROCESS_SCHEMA_VERSION,
  type TextPostprocessRule,
} from '@miniapp/shared';

export interface EditableRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  pattern: string;
  flags: string;
  replacement: string;
  css: string;
  notes: string;
}

export interface EditableSource {
  schema_version: typeof TEXT_POSTPROCESS_SCHEMA_VERSION;
  policy_version: typeof TEXT_POSTPROCESS_POLICY_VERSION;
  rules: EditableRule[];
}

export const RULE_FIELD_HELP = {
  pattern: '正则按 JavaScript 语法书写。发布时不能匹配空串。草稿可以先保存尚未编译通过的表达式。',
  flags: '只允许 g、i、m、s、u，且不能重复。没有 g 时每条规则只替换第一处。',
  replacement:
    '替换模板是受限 HTML。$& 是整段匹配，$1 是编号捕获，$<name> 是命名捕获，$$ 是字面量 $。捕获不能放进属性。',
  css: '样式只允许白名单属性和当前主题变量。选择器会在发布时被限制到本条规则，不能写外部地址或 !important。',
  notes: '说明只保存在规则草稿里，不会写进 System Instructions，也不会进入模型原文。',
} as const;

export const PREVIEW_SAMPLES = {
  full: [
    '她低声说：「今晚见」。',
    '',
    '[highlight]这是重点[/highlight]',
    '',
    '[status]天气晴，风很小[/status]',
    '',
    '[choice]留下',
    '[choice]离开',
    '',
    '普通 **markdown** 与 `code`。',
  ].join('\n'),
  plain: '这是一段没有规则标记的普通回复。\n\n- 列表一\n- 列表二',
  broken: '这里有未闭合的 [highlight]只有开头',
  choice: '[choice]接受邀请\n[choice]再考虑一下',
} as const;

export type PreviewSampleKey = keyof typeof PREVIEW_SAMPLES;

const STARTER_CSS = '.dialogue { color: hsl(var(--foreground)); font-size: 16px; padding: 0 2px; }';

export const STARTER_RULES: readonly TextPostprocessRule[] = [
  {
    id: 'dialogue',
    name: '对白',
    description: '把中文引号里的对白包进独立样式。',
    enabled: false,
    pattern: '「([^」]+)」',
    flags: 'g',
    replacement: '<span class="dialogue">$1</span>',
    css: STARTER_CSS,
    notes: '',
  },
  {
    id: 'highlight',
    name: '高亮',
    description: '把 [highlight] 段落显示为高亮。',
    enabled: false,
    pattern: String.raw`\[highlight\]([\s\S]+?)\[/highlight\]`,
    flags: 'g',
    replacement: '<mark>$1</mark>',
    css: '',
    notes: '',
  },
  {
    id: 'status',
    name: '状态',
    description: '把 [status] 段落显示为可折叠状态卡。',
    enabled: false,
    pattern: String.raw`\[status\]([\s\S]+?)\[/status\]`,
    flags: 'g',
    replacement: '<details open><summary>状态</summary><p>$1</p></details>',
    css: '',
    notes: '',
  },
  {
    id: 'choice',
    name: '选项',
    description: '把 [choice] 行显示为本地可点击选项。',
    enabled: false,
    pattern: String.raw`\[choice\]([^\r\n]+)`,
    flags: 'g',
    replacement: '<button>$1</button>',
    css: '',
    notes: '',
  },
];

export function blankRule(id: string): EditableRule {
  return {
    id,
    name: '未命名规则',
    description: '',
    enabled: false,
    pattern: '(?:待填写)',
    flags: 'g',
    replacement: '<span>$&</span>',
    css: '',
    notes: '',
  };
}
