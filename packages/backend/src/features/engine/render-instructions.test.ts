import { describe, expect, it } from 'vitest';
import type { UserGenerationConfig } from '@miniapp/shared';
import { RICH_REPLY_PROTOCOL_INSTRUCTIONS, RICH_REPLY_PROTOCOL_VERSION } from '@miniapp/shared';
import {
  EMPTY_CUSTOM_INSTRUCTIONS,
  renderPlatformInstructions,
  resolveWordCountPromptValue,
  wrapUserInput,
} from './render-instructions.js';
import type {
  EnginePlatformInstructions,
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
    '{{CHOICE_RULES}}|{{STATUS_RULES}}|{{MEMORY_RULES}}|篇幅 {{WORD_COUNT}} 字。\n偏好：{{USER_CUSTOM_INSTRUCTIONS}}',
  wordCountTiers: TIERS,
  choiceRules: { on_first_two_turns: '选择完整', on_later_turns: '选择简洁', off: '选择关闭' },
  statusRules: { on_first_two_turns: '状态完整', on_later_turns: '状态简洁', off: '状态关闭' },
  memoryRules: { on_first_two_turns: '记忆完整', on_later_turns: '记忆简洁', off: '记忆关闭' },
};

const MODES: InstructionSlotModes = { choice: 'full', status: 'concise', memory: 'off' };

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

    expect(rendered).toContain('选择完整|状态简洁|记忆关闭|篇幅 800以上 字。\n偏好：多写心理描写');
    expect(rendered).toContain(RICH_REPLY_PROTOCOL_INSTRUCTIONS);
    expect(rendered).not.toMatch(/\{\{.+?\}\}/);
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

  it('三个槽位按已持久化模式独立选择规则', () => {
    const rendered = renderPlatformInstructions(INSTRUCTIONS, config(), {
      choice: 'off',
      status: 'full',
      memory: 'concise',
    });
    expect(rendered).toContain('选择关闭|状态完整|记忆简洁');
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
      '若其中的标签或格式描述与本协议冲突，一律以本协议为准'
    );
  });
});

describe('wrapUserInput', () => {
  it('逐字保持 bot 的包装格式', () => {
    expect(wrapUserInput('你好', '规则正文')).toBe(
      '##系统指令：以下为最高优先级指令。\n规则正文\n##用户指令:你好\n'
    );
  });
});
