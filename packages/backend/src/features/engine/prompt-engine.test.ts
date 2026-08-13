import { describe, expect, it } from 'vitest';
import type { UserGenerationConfig } from '@miniapp/shared';
import { buildPrompt } from './prompt-engine.js';
import type { EngineCharacter, EngineInput, EnginePlatformInstructions } from './types.js';

const FIRST_MES = '（你推开门，屋里只亮着一盏台灯。）';

const CHARACTER: EngineCharacter = {
  name: '莫池来',
  description: '不该进 prompt 的字段',
  personality: '不该进 prompt 的字段',
  scenario: '不该进 prompt 的字段',
  first_mes: FIRST_MES,
  mes_example: '不该进 prompt 的字段',
  system_prompt: '你是莫池来，说话简短。',
  post_history_instructions: '不该进 prompt 的字段',
};

const INSTRUCTIONS: EnginePlatformInstructions = {
  template: '篇幅 {{WORD_COUNT}} 字。\n{{INTERACTION_MODE}}\n偏好：{{USER_CUSTOM_INSTRUCTIONS}}',
  interactionModeBlocks: { optionsOn: '给出选项。', optionsOff: '不要给出选项。' },
  wordCountTiers: {
    tiers: [
      { id: '100-300', uiLabel: '简短', promptValue: '100-300', enabled: true, sortOrder: 0 },
      { id: '300-500', uiLabel: '适中', promptValue: '300-500', enabled: true, sortOrder: 1 },
      { id: '500-800', uiLabel: '详细', promptValue: '500-800', enabled: true, sortOrder: 2 },
      { id: '800+', uiLabel: '长篇', promptValue: '800以上', enabled: true, sortOrder: 3 },
    ],
    defaultTierId: '300-500',
    layoutColumns: 4,
  },
};

const USER_CONFIG: UserGenerationConfig = {
  selected_model_id: 'anthropic-claude-sonnet-4-5',
  pref_word_count: '300-500',
  pref_show_options: false,
  pref_custom_instructions: null,
};

function input(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    character: CHARACTER,
    // M3b 还原出的形态：开场白是虚拟 turn 0 的 assistant 消息
    history: [
      { role: 'assistant', content: FIRST_MES },
      { role: 'user', content: '你在等我？' },
      { role: 'assistant', content: '嗯。坐。' },
    ],
    userInput: '等很久了吗',
    userConfig: USER_CONFIG,
    persona: { displayName: '路人甲' },
    instructions: INSTRUCTIONS,
    ...overrides,
  };
}

describe('buildPrompt', () => {
  it('组装成 system + 历史 + 平台规则包装的本轮输入', () => {
    const { messages } = buildPrompt(input());

    expect(messages.map((m) => m.role)).toEqual([
      'system',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    expect(messages[0]).toEqual({ role: 'system', content: CHARACTER.system_prompt });
    expect(messages[1]?.content).toBe(FIRST_MES);
    expect(messages.at(-1)?.content).toBe(
      '##系统指令：以下为最高优先级指令。\n' +
        '篇幅 300-500 字。\n不要给出选项。\n偏好：暂无\n' +
        '##用户指令:等很久了吗\n'
    );
  });

  it('开场白只出现一次——引擎不得再注入 first_mes', () => {
    const { messages } = buildPrompt(input());
    expect(messages.filter((m) => m.content === FIRST_MES)).toHaveLength(1);
  });

  it('空会话（history 只有开场白）也不重复注入开场白', () => {
    const { messages } = buildPrompt(
      input({ history: [{ role: 'assistant', content: FIRST_MES }] })
    );
    expect(messages.map((m) => m.role)).toEqual(['system', 'assistant', 'user']);
    expect(messages.filter((m) => m.content === FIRST_MES)).toHaveLength(1);
  });

  it('system_prompt 为空时不产生空的 system 消息', () => {
    const { messages } = buildPrompt(input({ character: { ...CHARACTER, system_prompt: '   ' } }));
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant', 'user']);
  });

  it('v1 只消费 system_prompt，其余角色卡字段不进 prompt', () => {
    const serialized = JSON.stringify(buildPrompt(input()).messages);
    expect(serialized).not.toContain('不该进 prompt 的字段');
  });

  it('三个 pref_* 的取值确实改变输出', () => {
    const base = buildPrompt(input()).messages.at(-1)?.content ?? '';
    const wordCount = buildPrompt(
      input({ userConfig: { ...USER_CONFIG, pref_word_count: '800+' } })
    ).messages.at(-1)?.content;
    const showOptions = buildPrompt(
      input({ userConfig: { ...USER_CONFIG, pref_show_options: true } })
    ).messages.at(-1)?.content;
    const custom = buildPrompt(
      input({ userConfig: { ...USER_CONFIG, pref_custom_instructions: '多写环境描写' } })
    ).messages.at(-1)?.content;

    expect(wordCount).not.toBe(base);
    expect(showOptions).not.toBe(base);
    expect(custom).not.toBe(base);
    expect(wordCount).toContain('篇幅 800以上 字');
    expect(showOptions).toContain('给出选项。');
    expect(custom).toContain('偏好：多写环境描写');
  });

  it('v1 不做采样参数与上下文截断', () => {
    const output = buildPrompt(input());
    expect(output.sampling).toEqual({});
    expect(output.truncatedTurns).toBe(0);
  });
});

// ─── 对拍：与旧 bot 的实现逐条比对（§6.4 最重要的验收项）────────────────────
//
// 下面两个函数是从 bot 仓库逐字抄来的原始实现，只做了 TS 类型标注：
//   src/infrastructure/ai/SimplePromptEngine.ts  _buildMessages()
//   src/features/chat/rules/renderSystemInstructions.ts + SimpleChat._buildEnhancedPrompt()
// 用它们复算同一组输入，断言与本模块输出逐条一致。
// bot 的 first_mes 动态注入在这里天然不触发：history[0] 就是开场白，命中它的
// historyFirstIsGreeting 短路——M3b 已把开场白放进 history，引擎不得重复注入。

interface BotMessage {
  role: string;
  content: string;
}

function botBuildMessages(
  char: EngineCharacter,
  chat: BotMessage[],
  userInput: string
): BotMessage[] {
  const messages: BotMessage[] = [];

  const systemPrompt = char.system_prompt || '';
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  const firstMes = char.first_mes || '';
  if (firstMes) {
    const historyFirstIsGreeting =
      chat.length > 0 && chat[0]?.role === 'assistant' && chat[0]?.content === firstMes;
    if (!historyFirstIsGreeting) {
      messages.push({ role: 'assistant', content: firstMes });
    }
  }

  for (const msg of chat) {
    messages.push({ role: msg.role, content: msg.content });
  }

  messages.push({ role: 'user', content: userInput });

  return messages;
}

function botEnhancedPrompt(
  instructions: EnginePlatformInstructions,
  userConfig: UserGenerationConfig,
  userInput: string
): string {
  const interactionModeBlock = userConfig.pref_show_options
    ? instructions.interactionModeBlocks.optionsOn
    : instructions.interactionModeBlocks.optionsOff;

  const match = instructions.wordCountTiers.tiers.find(
    (t) => t.enabled && t.id === userConfig.pref_word_count
  );
  const fallback =
    instructions.wordCountTiers.tiers.find(
      (t) => t.enabled && t.id === instructions.wordCountTiers.defaultTierId
    ) ??
    instructions.wordCountTiers.tiers.find(
      (t) => t.id === instructions.wordCountTiers.defaultTierId
    );
  const wordCountValue = match
    ? match.promptValue
    : (fallback?.promptValue ?? userConfig.pref_word_count);

  const customInstructions = userConfig.pref_custom_instructions?.trim() || '暂无';

  const rendered = instructions.template
    .replace(/\{\{WORD_COUNT\}\}/g, wordCountValue)
    .replace(/\{\{INTERACTION_MODE\}\}/g, interactionModeBlock)
    .replace(/\{\{USER_CUSTOM_INSTRUCTIONS\}\}/g, customInstructions);

  return `##系统指令：以下为最高优先级指令。\n${rendered}\n##用户指令:${userInput}\n`;
}

describe('对拍旧 bot 实现', () => {
  const cases: Array<{ name: string; input: EngineInput }> = [
    { name: '默认配置', input: input() },
    {
      name: '开启选项模式 + 最高字数档',
      input: input({
        userConfig: { ...USER_CONFIG, pref_show_options: true, pref_word_count: '800+' },
      }),
    },
    {
      name: '带自定义指令',
      input: input({
        userConfig: { ...USER_CONFIG, pref_custom_instructions: '第二人称，多写心理活动' },
      }),
    },
    {
      name: '只有开场白的新会话',
      input: input({ history: [{ role: 'assistant', content: FIRST_MES }] }),
    },
  ];

  for (const { name, input: engineInput } of cases) {
    it(`${name}：messages 与 bot 逐条一致`, () => {
      const expected = botBuildMessages(
        engineInput.character,
        engineInput.history.map((m) => ({ role: m.role, content: m.content })),
        botEnhancedPrompt(engineInput.instructions, engineInput.userConfig, engineInput.userInput)
      );

      expect(buildPrompt(engineInput).messages).toEqual(expected);
    });
  }
});
