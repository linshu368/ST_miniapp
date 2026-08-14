// Prompt 引擎（M2）的唯一入口契约。后端内部类型，不进 shared。
//
// v1 是旧 bot 的忠实移植（SillyTavern/src/infrastructure/ai/SimplePromptEngine.ts 的
// _buildMessages 加 SimpleChat._buildEnhancedPrompt 加 rules/renderSystemInstructions.ts）：
// messages = [system: 角色卡 system_prompt] + 历史 + [user: 平台规则 + 本轮用户输入]。
// 不消费 platform_presets.preset_payload，不做酒馆语义适配（世界书、正则、卡内嵌资源）。
// {{user}} 是唯一例外：组 prompt 时替换为 persona.displayName。

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
 * 字数档位：id 与用户 pref_word_count 匹配；promptValue 注入 {{WORD_COUNT}}。
 * 运营台可增删档位；解析层兼容 071 旧 shape（label / default_value）。
 */
export interface EngineWordCountTiers {
  tiers: Array<{
    id: string;
    uiLabel: string;
    promptValue: string;
    enabled: boolean;
    sortOrder: number;
  }>;
  defaultTierId: string;
  layoutColumns: 2 | 3 | 4;
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

export interface EngineInput {
  character: EngineCharacter;
  /**
   * 会话历史，按 turn 升序、同轮 user 在前。
   * 开场白已由 M3b 作为虚拟 turn 0 包含在内：首轮取角色卡，之后取首轮 prompt 快照。
   * 因此引擎**不得**再注入 character.first_mes，否则每轮都会重复一条。
   * 本轮用户输入不在其中，见 userInput。
   * 窗口下界以 SQL 为准，这里已经是泄洪后的切片，引擎不得再 slice。
   */
  history: EngineHistoryMessage[];
  /**
   * 被窗口截掉的早期轮数。由 SQL 窗口起点算出，引擎只回填观测字段。
   * 未泄洪或缺省为 0。
   */
  truncatedTurns?: number;
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
   * 被窗口截掉的早期轮数，用于观测。
   * 窗口下界以 SQL 为准；引擎原样回填 input.truncatedTurns，不再二次裁剪。
   */
  truncatedTurns: number;
}

export interface PromptEngine {
  build(input: EngineInput): EngineOutput;
}
