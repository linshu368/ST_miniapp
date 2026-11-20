import { describe, expect, it } from 'vitest';
import type { UserGenerationConfig } from '@miniapp/shared';
import { buildPrompt } from './prompt-engine.js';
import { renderUserSettings } from './user-settings.js';
import type { EngineInput, EnginePlatformInstructions } from './types.js';

const INSTRUCTIONS: EnginePlatformInstructions = {
  template: '篇幅 {{WORD_COUNT}} 字。偏好：{{USER_CUSTOM_INSTRUCTIONS}}',
  wordCountTiers: {
    tiers: [{ id: 'a', uiLabel: '适中', promptValue: '300-500', enabled: true, sortOrder: 0 }],
    defaultTierId: 'a',
    layoutColumns: 2,
  },
  choiceRules: { on_first_two_turns: '', on_later_turns: '', off: '' },
  memoryRules: { on_first_two_turns: '', on_later_turns: '', off: '' },
  replyStyles: [],
  driveModes: null,
};

const USER_CONFIG: UserGenerationConfig = {
  selected_model_id: 'm',
  pref_word_count: 'a',
  pref_show_options: false,
  pref_show_status: false,
  pref_show_memory: false,
  pref_custom_instructions: null,
};

function input(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    character: {
      name: '沈砚',
      description: '',
      personality: '',
      scenario: '',
      first_mes: '开场',
      mes_example: '',
      system_prompt: '你是沈砚。',
      post_history_instructions: '',
    },
    history: [
      { role: 'assistant', content: '开场' },
      { role: 'user', content: '嗯' },
      { role: 'assistant', content: '坐。' },
    ],
    userInput: '继续',
    userConfig: USER_CONFIG,
    slotModes: { choice: 'off', memory: 'off' },
    persona: { displayName: '阿远' },
    instructions: INSTRUCTIONS,
    ...overrides,
  };
}

describe('renderUserSettings', () => {
  it('两段都空（含纯空白）返回 null', () => {
    expect(renderUserSettings({ notes: '', personaDescription: '' })).toBeNull();
    expect(renderUserSettings({ notes: '  \n ', personaDescription: ' ' })).toBeNull();
  });

  it('只有补充设定或只有人设时只出现对应一段', () => {
    const notes = renderUserSettings({ notes: '小红：侍女', personaDescription: '' });
    expect(notes).toContain('【用户补充设定】');
    expect(notes).toContain('小红：侍女');
    expect(notes).not.toContain('【主角人设】');

    const persona = renderUserSettings({ notes: '', personaDescription: '落魄书生' });
    expect(persona).toContain('【主角人设】');
    expect(persona).not.toContain('【用户补充设定】');
  });

  it('两段都有时补充设定在前、人设在后', () => {
    const both = renderUserSettings({ notes: '小红：侍女', personaDescription: '落魄书生' })!;
    expect(both.indexOf('【用户补充设定】')).toBeLessThan(both.indexOf('【主角人设】'));
  });
});

describe('buildPrompt 用户设定', () => {
  it('没有设置时 prompt 与不传 userSettings 完全一致', () => {
    const baseline = buildPrompt(input()).messages;
    expect(
      buildPrompt(input({ userSettings: { notes: '', personaDescription: '' } })).messages
    ).toEqual(baseline);
  });

  it('顺序固定：角色卡 → 用户设定 → 会话记忆 → 历史 → 本轮', () => {
    const messages = buildPrompt(
      input({
        storyMemory: '前情提要',
        userSettings: { notes: '小红：侍女', personaDescription: '落魄书生' },
      })
    ).messages;
    expect(messages.slice(0, 3).map((m) => m.role)).toEqual(['system', 'system', 'system']);
    expect(messages[0]!.content).toBe('你是沈砚。');
    expect(messages[1]!.content).toContain('小红：侍女');
    expect(messages[2]!.content).toBe('前情提要');
    expect(messages.at(-1)!.role).toBe('user');
  });

  it('设定里的 {{user}} 被替换成昵称', () => {
    const messages = buildPrompt(
      input({ userSettings: { notes: '{{user}} 是沈砚的故人', personaDescription: '' } })
    ).messages;
    expect(messages[1]!.content).toContain('阿远 是沈砚的故人');
    expect(messages[1]!.content).not.toContain('{{user}}');
  });

  it('历史被截断、记忆压缩前后，用户设定那条消息原样存在', () => {
    const userSettings = { notes: '小红：侍女', personaDescription: '落魄书生' };
    const longHistory = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? ('assistant' as const) : ('user' as const),
      content: `第 ${i} 条`,
    }));
    const before = buildPrompt(input({ history: longHistory, userSettings })).messages;
    // 截断 + 压缩：历史只剩最近几条，多出一条记忆
    const after = buildPrompt(
      input({ history: longHistory.slice(-4), storyMemory: '前情提要', userSettings })
    ).messages;

    const settingsOf = (messages: { role: string; content: string }[]) =>
      messages.find((m) => m.role === 'system' && m.content.includes('【用户补充设定】'));
    expect(settingsOf(before)).toBeDefined();
    expect(settingsOf(after)).toEqual(settingsOf(before));
    expect(after.length).toBeLessThan(before.length);
  });
});
