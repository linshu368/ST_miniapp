import {
  TEXT_POSTPROCESS_POLICY_VERSION,
  TEXT_POSTPROCESS_SCHEMA_VERSION,
  RICH_REPLY_RULE_STYLES,
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
    '替换模板支持安全 HTML 语义标签和普通展示属性。$& 是整段匹配，$1 是编号捕获，$<name> 是命名捕获，$$ 是字面量 $。捕获不能放进属性，脚本、事件、链接和外部资源仍会被拒绝。',
  css: '样式只作用于本条规则生成的内容。不能写外部地址、动画、视口覆盖或 !important。',
  notes: '说明只保存在规则草稿里，不会写进 System Instructions，也不会进入模型原文。',
} as const;

export const PREVIEW_SAMPLES = {
  full: [
    '她低声说：“今晚见”。',
    '',
    '[choices]',
    '[choice]握住她的手[/choice]',
    '[choice]再问一次[/choice]',
    '[choice]安静等待[/choice]',
    '[/choices]',
    '',
    '[status]',
    '<details><summary>此刻</summary>',
    '```markdown',
    '地点：花园',
    '时间：深夜',
    '```',
    '</details>',
    '[/status]',
    '',
    '[memory]',
    '<details><summary>工作记忆</summary>',
    '```markdown',
    '当前记忆数目：1/7',
    '```',
    '</details>',
    '[/memory]',
    '',
    '普通 **markdown** 与 `code`。',
  ].join('\n'),
  plain: '这是一段没有规则标记的普通回复。\n\n- 列表一\n- 列表二',
  broken: '这里有未闭合的 [highlight]只有开头',
  choice:
    '[choices]\n[choice]接受邀请[/choice]\n[choice]再考虑一下[/choice]\n[choice]先观察[/choice]\n[/choices]',
} as const;

export type PreviewSampleKey = keyof typeof PREVIEW_SAMPLES;

export const STARTER_RULES: readonly TextPostprocessRule[] = [
  {
    id: 'choice',
    name: '选项',
    description: '固定识别 3 个选项，并显示为本地可点击选项。',
    enabled: false,
    pattern: String.raw`\[choices\]\s*\[choice\]\s*((?:(?!\[\/?(?:choice|choices)\])[\s\S])*?)\s*\[\/choice\]\s*\[choice\]\s*((?:(?!\[\/?(?:choice|choices)\])[\s\S])*?)\s*\[\/choice\]\s*\[choice\]\s*((?:(?!\[\/?(?:choice|choices)\])[\s\S])*?)\s*\[\/choice\]\s*\[\/choices\]`,
    flags: 'g',
    replacement: `<details class="rp-unit rp-unit--choices"><summary><span class="rp-unit__heading"><strong>接下来……</strong><small>想怎么回应？ · 3 个选项</small></span><span class="rp-unit__chevron" aria-hidden="true">›</span></summary><div class="rp-unit__body rp-choice-list"><button type="button" class="rp-choice"><span>$1</span><span class="rp-choice__arrow" aria-hidden="true">→</span></button><button type="button" class="rp-choice"><span>$2</span><span class="rp-choice__arrow" aria-hidden="true">→</span></button><button type="button" class="rp-choice"><span>$3</span><span class="rp-choice__arrow" aria-hidden="true">→</span></button></div></details>`,
    css: RICH_REPLY_RULE_STYLES.choice,
    notes: '',
  },
  {
    id: 'status',
    name: '状态',
    description: '把 [status] 段落显示为可折叠状态卡。',
    enabled: false,
    pattern: String.raw`\[status\]\s*((?:(?!\[\/?status\])[\s\S])*?)\s*\[\/status\]`,
    flags: 'g',
    replacement:
      '<details class="rp-unit rp-unit--status"><summary><span class="rp-unit__heading"><strong>人物近况</strong><small>这一刻的变化</small></span><span class="rp-unit__chevron" aria-hidden="true">›</span></summary><div class="rp-unit__body rp-panel-list">$1</div></details>',
    css: RICH_REPLY_RULE_STYLES.status,
    notes: '',
  },
  {
    id: 'memory',
    name: '记忆',
    description: '把 [memory] 段落显示为可折叠记忆卡。',
    enabled: false,
    pattern: String.raw`\[memory\]\s*((?:(?!\[\/?memory\])[\s\S])*?)\s*\[\/memory\]`,
    flags: 'g',
    replacement:
      '<details class="rp-unit rp-unit--memory"><summary><span class="rp-unit__heading"><strong>故事记忆</strong><small>已记住这段经历</small></span><span class="rp-unit__chevron" aria-hidden="true">›</span></summary><div class="rp-unit__body rp-panel-list rp-memory-list">$1</div></details>',
    css: RICH_REPLY_RULE_STYLES.memory,
    notes: '',
  },
  {
    id: 'dialogue',
    name: '对白',
    description: '把中文引号里的对白包进独立样式。',
    enabled: false,
    pattern: '“([^”\\r\\n]{1,500})”',
    flags: 'g',
    replacement: '<span class="rp-dialogue">“$1”</span>',
    css: RICH_REPLY_RULE_STYLES.dialogue,
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
