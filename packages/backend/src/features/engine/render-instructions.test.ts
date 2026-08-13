import { describe, expect, it } from 'vitest';
import type { UserGenerationConfig } from '@miniapp/shared';
import {
  EMPTY_CUSTOM_INSTRUCTIONS,
  renderPlatformInstructions,
  resolveWordCountPromptValue,
  wrapUserInput,
} from './render-instructions.js';
import type { EnginePlatformInstructions, EngineWordCountTiers } from './types.js';

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
  template: '篇幅 {{WORD_COUNT}} 字。\n{{INTERACTION_MODE}}\n偏好：{{USER_CUSTOM_INSTRUCTIONS}}',
  interactionModeBlocks: { optionsOn: '给出选项。', optionsOff: '不要给出选项。' },
  wordCountTiers: TIERS,
};

function config(overrides: Partial<UserGenerationConfig> = {}): UserGenerationConfig {
  return {
    selected_model_id: 'anthropic-claude-sonnet-4-5',
    pref_word_count: '300-500',
    pref_show_options: false,
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
  it('三个占位符全部被替换，产物里不留 {{...}}', () => {
    const rendered = renderPlatformInstructions(
      INSTRUCTIONS,
      config({
        pref_word_count: '800+',
        pref_show_options: true,
        pref_custom_instructions: '多写心理描写',
      })
    );

    expect(rendered).toBe('篇幅 800以上 字。\n给出选项。\n偏好：多写心理描写');
    expect(rendered).not.toMatch(/\{\{.+?\}\}/);
  });

  it('pref_show_options 决定注入哪一块选项模式指令', () => {
    expect(renderPlatformInstructions(INSTRUCTIONS, config({ pref_show_options: true }))).toContain(
      '给出选项。'
    );
    expect(
      renderPlatformInstructions(INSTRUCTIONS, config({ pref_show_options: false }))
    ).toContain('不要给出选项。');
  });

  it('pref_custom_instructions 为空或纯空白时注入「暂无」', () => {
    expect(renderPlatformInstructions(INSTRUCTIONS, config())).toContain(
      `偏好：${EMPTY_CUSTOM_INSTRUCTIONS}`
    );
    expect(
      renderPlatformInstructions(INSTRUCTIONS, config({ pref_custom_instructions: '   \n ' }))
    ).toContain(`偏好：${EMPTY_CUSTOM_INSTRUCTIONS}`);
  });

  it('同一个占位符出现多次时全部替换', () => {
    const rendered = renderPlatformInstructions(
      { ...INSTRUCTIONS, template: '{{WORD_COUNT}} / {{WORD_COUNT}}' },
      config({ pref_word_count: '500-800' })
    );
    expect(rendered).toBe('500-800 / 500-800');
  });

  it('自定义指令里的 $& 等替换模式按字面量注入', () => {
    const rendered = renderPlatformInstructions(
      { ...INSTRUCTIONS, template: '偏好：{{USER_CUSTOM_INSTRUCTIONS}}' },
      config({ pref_custom_instructions: "$& $` $' $1" })
    );
    expect(rendered).toBe("偏好：$& $` $' $1");
  });
});

describe('wrapUserInput', () => {
  it('逐字保持 bot 的包装格式', () => {
    expect(wrapUserInput('你好', '规则正文')).toBe(
      '##系统指令：以下为最高优先级指令。\n规则正文\n##用户指令:你好\n'
    );
  });
});
