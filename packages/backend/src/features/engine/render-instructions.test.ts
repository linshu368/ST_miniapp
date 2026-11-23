import { describe, expect, it } from 'vitest';
import type { UserGenerationConfig } from '@miniapp/shared';
import {
  FALLBACK_DRIVE_RULES,
  RICH_REPLY_PROTOCOL_INSTRUCTIONS,
  RICH_REPLY_PROTOCOL_VERSION,
  type DriveModesConfig,
} from '@miniapp/shared';
import {
  applyReplyStyles,
  EMPTY_CUSTOM_INSTRUCTIONS,
  renderPlatformInstructions,
  resolveWordCountPromptValue,
  wrapUserInput,
} from './render-instructions.js';
import type {
  EnginePlatformInstructions,
  EngineReplyStyle,
  EngineWordCountTiers,
  InstructionSlotModes,
} from './types.js';

const TIERS: EngineWordCountTiers = {
  tiers: [
    { id: '100-300', uiLabel: '简短', promptValue: '100-300', enabled: true, sortOrder: 0 },
    { id: '300-500', uiLabel: '适中', promptValue: '300-500', enabled: true, sortOrder: 1 },
    { id: '500-800', uiLabel: '详细', promptValue: '500-800', enabled: true, sortOrder: 2 },
    { id: '800+', uiLabel: '长篇', promptValue: '800以上', enabled: true, sortOrder: 3 },
  ],
  defaultTierId: '300-500',
  layoutColumns: 4,
};

const INSTRUCTIONS: EnginePlatformInstructions = {
  template:
    '{{CHOICE_RULES}}|{{MEMORY_RULES}}|篇幅 {{WORD_COUNT}} 字。\n偏好：{{USER_CUSTOM_INSTRUCTIONS}}',
  wordCountTiers: TIERS,
  choiceRules: { on_first_two_turns: '选择完整', on_later_turns: '选择简洁', off: '选择关闭' },
  replyStyles: [],
  driveModes: null,
};

const MODES: InstructionSlotModes = { choice: 'full' };
const MODE_SLOTS = MODES;

function config(overrides: Partial<UserGenerationConfig> = {}): UserGenerationConfig {
  return {
    selected_model_id: 'anthropic-claude-sonnet-4-5',
    pref_word_count: '300-500',
    pref_show_options: false,
    pref_show_status: true,
    pref_show_memory: true,
    pref_custom_instructions: null,
    ...overrides,
  };
}

describe('resolveWordCountPromptValue', () => {
  it('命中每个档位 id，都不回落到默认档', () => {
    expect(resolveWordCountPromptValue('100-300', TIERS)).toBe('100-300');
    expect(resolveWordCountPromptValue('300-500', TIERS)).toBe('300-500');
    expect(resolveWordCountPromptValue('500-800', TIERS)).toBe('500-800');
    expect(resolveWordCountPromptValue('800+', TIERS)).toBe('800以上');
  });

  it('id 对不上或已下线时回落到 defaultTierId 的 promptValue', () => {
    expect(resolveWordCountPromptValue('150以内', TIERS)).toBe('300-500');
    expect(resolveWordCountPromptValue('800以上', TIERS)).toBe('300-500');

    const withDisabled: EngineWordCountTiers = {
      ...TIERS,
      tiers: TIERS.tiers.map((tier) => (tier.id === '800+' ? { ...tier, enabled: false } : tier)),
    };
    expect(resolveWordCountPromptValue('800+', withDisabled)).toBe('300-500');
  });

  it('匹配的是 id 而不是 promptValue / uiLabel', () => {
    expect(resolveWordCountPromptValue('800以上', TIERS)).not.toBe('800以上');
    expect(resolveWordCountPromptValue('长篇', TIERS)).not.toBe('800以上');
  });
});

describe('renderPlatformInstructions', () => {
  it('两个占位符全部被替换，产物里不留 {{...}}', () => {
    const rendered = renderPlatformInstructions(
      INSTRUCTIONS,
      config({
        pref_word_count: '800+',
        pref_show_options: true,
        pref_custom_instructions: '多写心理描写',
      }),
      MODES
    );

    // 记忆栏改由独立模型记录：{{MEMORY_RULES}} 一律渲染为空。
    expect(rendered).toContain('选择完整||篇幅 800以上 字。\n偏好：多写心理描写');
    expect(rendered).toContain(RICH_REPLY_PROTOCOL_INSTRUCTIONS);
    expect(rendered).not.toMatch(/\{\{.+?\}\}/);
  });

  it('旧模板里残留的状态栏占位直接去掉', () => {
    const rendered = renderPlatformInstructions(
      { ...INSTRUCTIONS, template: `{{STATUS_RULES}}\n${INSTRUCTIONS.template}` },
      config({}),
      MODES
    );
    expect(rendered).not.toContain('{{STATUS_RULES}}');
    expect(rendered.startsWith('\n')).toBe(true);
  });

  it('不再消费废弃 INTERACTION_MODE；旧模板必须由读取层拒绝', () => {
    const legacy = { ...INSTRUCTIONS, template: '{{INTERACTION_MODE}}\n{{WORD_COUNT}}' };
    expect(
      renderPlatformInstructions(legacy, config({ pref_show_options: true }), MODES)
    ).toContain('{{INTERACTION_MODE}}\n300-500');
  });

  it('pref_custom_instructions 为空或纯空白时注入「暂无」', () => {
    expect(renderPlatformInstructions(INSTRUCTIONS, config(), MODES)).toContain(
      `偏好：${EMPTY_CUSTOM_INSTRUCTIONS}`
    );
    expect(
      renderPlatformInstructions(
        INSTRUCTIONS,
        config({ pref_custom_instructions: '   \n ' }),
        MODES
      )
    ).toContain(`偏好：${EMPTY_CUSTOM_INSTRUCTIONS}`);
  });

  it('同一个占位符出现多次时全部替换', () => {
    const rendered = renderPlatformInstructions(
      { ...INSTRUCTIONS, template: '{{WORD_COUNT}} / {{WORD_COUNT}}' },
      config({ pref_word_count: '500-800' }),
      MODES
    );
    expect(rendered).toContain('500-800 / 500-800');
  });

  it('自定义指令里的 $& 等替换模式按字面量注入', () => {
    const rendered = renderPlatformInstructions(
      { ...INSTRUCTIONS, template: '偏好：{{USER_CUSTOM_INSTRUCTIONS}}' },
      config({ pref_custom_instructions: "$& $` $' $1" }),
      MODES
    );
    expect(rendered).toContain("偏好：$& $` $' $1");
  });

  it('选项槽位按已持久化模式选择规则；旧模板里残留的记忆栏占位渲染为空', () => {
    const rendered = renderPlatformInstructions(INSTRUCTIONS, config(), { choice: 'off' });
    expect(rendered).toContain('选择关闭||篇幅');
    expect(rendered).not.toContain('{{MEMORY_RULES}}');
  });

  it('固定协议只注入一次，且操作员槽位文案不能替代机器语法', () => {
    const rendered = renderPlatformInstructions(
      {
        ...INSTRUCTIONS,
        template: `${INSTRUCTIONS.template}\n${RICH_REPLY_PROTOCOL_INSTRUCTIONS}`,
      },
      config(),
      MODES
    );
    expect(
      rendered.match(new RegExp(`回复富文本协议（v${RICH_REPLY_PROTOCOL_VERSION}`, 'g'))
    ).toHaveLength(1);
    expect(renderPlatformInstructions(INSTRUCTIONS, config(), MODES)).toContain(
      '不要输出状态栏、记忆栏'
    );
  });
});

describe('回复风格注入', () => {
  const STYLES: EngineReplyStyle[] = [
    { id: 'style-a', marker: '{{CHIDU}}', rules: '尺度规则', enabled: true },
    { id: 'style-b', marker: '{{TUIJIN}}', rules: '推进规则', enabled: true },
    { id: 'style-c', marker: '{{QINMI}}', rules: '亲密规则', enabled: false },
  ];
  const STYLED: EnginePlatformInstructions = {
    ...INSTRUCTIONS,
    template: `${INSTRUCTIONS.template}\n风格：[{{CHIDU}}][{{TUIJIN}}][{{QINMI}}]`,
    replyStyles: STYLES,
  };

  // 回归：上线后 marker 从未被替换，模型收到的是字面量 {{CHIDU}}，用户开关全部无效。
  it('开启的风格替换为规则，未开启/目录停用的清空，不留占位符', () => {
    const rendered = renderPlatformInstructions(
      STYLED,
      config({ pref_reply_styles: { 'style-a': true, 'style-b': false, 'style-c': true } }),
      MODES
    );
    expect(rendered).toContain('风格：[尺度规则][][]');
    expect(rendered).not.toMatch(/\{\{.+?\}\}/);
  });

  it('没有任何偏好时全部 marker 清空', () => {
    const rendered = renderPlatformInstructions(STYLED, config(), MODES);
    expect(rendered).toContain('风格：[][][]');
  });

  it('开启但 marker 不在模板里的风格，规则追加在模板末尾、协议之前', () => {
    const rendered = renderPlatformInstructions(
      {
        ...INSTRUCTIONS,
        replyStyles: [{ id: 'style-d', marker: '{{MISSING}}', rules: '追加规则', enabled: true }],
      },
      config({ pref_reply_styles: { 'style-d': true } }),
      MODES
    );
    expect(rendered).toContain('追加规则');
    expect(rendered.indexOf('追加规则')).toBeLessThan(
      rendered.indexOf(RICH_REPLY_PROTOCOL_INSTRUCTIONS)
    );
  });

  it('一次扫描替换：规则里含别的 marker 或替换模式时按字面量保留', () => {
    const rendered = applyReplyStyles(
      '[{{A}}][{{B}}]',
      [
        { id: 'style-a', marker: '{{A}}', rules: '含{{B}}和$&', enabled: true },
        { id: 'style-b', marker: '{{B}}', rules: 'B规则', enabled: true },
      ],
      { 'style-a': true, 'style-b': true }
    );
    expect(rendered).toBe('[含{{B}}和$&][B规则]');
  });

  it('用户自由文本里的同名 marker 不会被展开', () => {
    const rendered = renderPlatformInstructions(
      { ...STYLED, template: '偏好：{{USER_CUSTOM_INSTRUCTIONS}} {{CHIDU}}' },
      config({ pref_reply_styles: { 'style-a': true }, pref_custom_instructions: '{{CHIDU}}' }),
      MODES
    );
    expect(rendered).toContain('偏好：{{CHIDU}} 尺度规则');
  });
});

describe('剧情模式注入', () => {
  const MODES: DriveModesConfig = {
    modes: [
      {
        id: 'follow',
        ui_label: '我来带',
        description: '',
        rules: '跟随规则',
        enabled: true,
        sort_order: 0,
      },
      {
        id: 'active',
        ui_label: '等 TA 撩',
        description: '',
        rules: '主动规则',
        enabled: true,
        sort_order: 1,
      },
      {
        id: 'novel',
        ui_label: '替我演',
        description: '',
        rules: '小说规则',
        enabled: false,
        sort_order: 3,
      },
    ],
    default_mode_id: 'active',
  };
  const DRIVEN: EnginePlatformInstructions = {
    ...INSTRUCTIONS,
    template: `${INSTRUCTIONS.template}\n模式：[{{DRIVE_RULES}}]`,
    driveModes: MODES,
  };

  it('按用户所选档位注入规则', () => {
    const rendered = renderPlatformInstructions(
      DRIVEN,
      config({ pref_drive_mode: 'follow' }),
      MODE_SLOTS
    );
    expect(rendered).toContain('模式：[跟随规则]');
  });

  it('未选、已停用或未知档位回落到默认档', () => {
    for (const pref of [undefined, 'novel', 'gone']) {
      const rendered = renderPlatformInstructions(
        DRIVEN,
        config(pref === undefined ? {} : { pref_drive_mode: pref }),
        MODE_SLOTS
      );
      expect(rendered).toContain('模式：[主动规则]');
    }
  });

  // 配置缺失或损坏时必须退回上线前的防抢话，不能留空槽位或原样发出占位符。
  it('未配置剧情模式时注入内置保守规则', () => {
    const rendered = renderPlatformInstructions(
      { ...DRIVEN, driveModes: null },
      config({ pref_drive_mode: 'follow' }),
      MODE_SLOTS
    );
    expect(rendered).toContain(`模式：[${FALLBACK_DRIVE_RULES}]`);
    expect(rendered).not.toContain('{{DRIVE_RULES}}');
  });
});

describe('wrapUserInput', () => {
  it('逐字保持 bot 的包装格式', () => {
    expect(wrapUserInput('你好', '规则正文')).toBe(
      '##系统指令：以下为最高优先级指令。\n规则正文\n##用户指令:你好\n'
    );
  });
});
