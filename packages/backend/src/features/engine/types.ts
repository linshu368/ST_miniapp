// Prompt 引擎（M2）的唯一入口契约。后端内部类型，不进 shared。
//
// v1 是旧 bot 的忠实移植（SillyTavern/src/infrastructure/ai/SimplePromptEngine.ts 的
// _buildMessages 加 SimpleChat._buildEnhancedPrompt 加 rules/renderSystemInstructions.ts）：
// messages = [system: 角色卡 system_prompt] + 历史 + [user: 平台规则 + 本轮用户输入]。
// 不消费 platform_presets.preset_payload，不做酒馆语义适配（宏、世界书、正则）。

import type { UserGenerationConfig } from '@miniapp/shared';

/**
 * 角色卡基础字段组，取自 miniapp.characters。
 * v1 只消费 system_prompt；其余字段先在接缝里占位，是为了让「把人设也写进 system 段」
 * 这类调整只改引擎实现、不动 M1 与 M3b 的取数与调用方。
 */
export interface EngineCharacter {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  system_prompt: string;
  post_history_instructions: string;
}

export interface EngineHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * 平台规则的权威来源，读自 miniapp.runtime_config。
 * 对齐旧 bot 的 system_instructions 模板机制，三个占位符是 pref_* 得以生效的前提：
 * {{WORD_COUNT}} / {{INTERACTION_MODE}} / {{USER_CUSTOM_INSTRUCTIONS}}。
 */
export interface EnginePlatformInstructions {
  template: string;
  interactionModeBlocks: {
    optionsOn: string;
    optionsOff: string;
  };
  wordCountTiers: EngineWordCountTiers;
}

/**
 * 字数档位：label 用于匹配用户选择，prompt_value 是注入模板的值。
 * label 必须与 shared 的 PreferredWordCount 取值一致（'100-300' / '300-500' / '500-800' / '800+'），
 * 否则匹配失败会静默回落到 defaultValue。旧 bot 的档位文案（'150以内' / '800以上'）与之不同，
 * 配置落库时需要按 miniapp 的枚举重写。
 */
export interface EngineWordCountTiers {
  tiers: Array<{ label: string; promptValue: string }>;
  defaultValue: string;
}

export interface EngineInput {
  character: EngineCharacter;
  /**
   * 会话历史，按 turn 升序、同轮 user 在前。
   * 开场白已作为 turn 0 的 assistant 消息包含在内（本轮决策 3），因此引擎**不得**再注入
   * character.first_mes——旧 bot 因为开场白不入库才需要动态注入，这里的前提相反。
   * 本轮用户输入不在其中，见 userInput。
   */
  history: EngineHistoryMessage[];
  /** 本轮用户输入原文。引擎负责把平台规则包装在它外面后作为最后一条 user 消息 */
  userInput: string;
  userConfig: UserGenerationConfig;
  persona: { displayName: string | null };
  instructions: EnginePlatformInstructions;
}

export interface EngineMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface EngineOutput {
  messages: EngineMessage[];
  /**
   * 从预设解析出的采样参数，透传给上游。
   * v1 恒为空对象——旧 bot 的请求体只有 model / messages / stream，采样一律用上游默认值。
   * 保留该字段是为了后续接入 preset_payload 顶层采样参数时不必改动 M3a 的入参形状。
   */
  sampling: Record<string, number>;
  /**
   * 被窗口截断掉的轮数，用于观测。
   * v1 恒为 0：旧 bot 把历史全量入 prompt，没有任何上下文长度管理，忠实移植即不截断。
   * 上限策略后置，届时只需改引擎实现。
   */
  truncatedTurns: number;
}

export interface PromptEngine {
  build(input: EngineInput): EngineOutput;
}
