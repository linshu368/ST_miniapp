// Prompt 引擎的唯一入口契约。后端内部类型，不进 shared。
//
// 最终形状：messages = [system: 角色卡 system_prompt] + 历史 + [user: 平台规则 + 本轮用户输入]。
// 不支持酒馆语义（预设、宏、世界书、正则、卡内嵌资源），表现质量全部由 system prompt
// 与本模块的组装逻辑承担。
// {{user}} 是唯一例外：组 prompt 时替换为 persona.displayName。

import type { DriveModesConfig, InstructionSlotRules, UserGenerationConfig } from '@miniapp/shared';

/** Persisted by the turn-start RPC; never part of a public DTO. */
export type InstructionSlotMode = 'full' | 'concise' | 'off';

/** 正文模型只剩选项一个槽位：状态栏、记忆栏都由独立模型记录、聊天页右侧面板展示。 */
export interface InstructionSlotModes {
  choice: InstructionSlotMode;
}

/**
 * 角色卡基础字段组，取自 app_core.characters。
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

export interface EngineUserSettings {
  /** 用户为这张卡补充的设定（可写多个人物）。 */
  notes: string;
  /** 用户扮演的主角人设描述。名字不进这里，称呼仍用昵称。 */
  personaDescription: string;
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
 * 平台规则的权威来源，读自 app_core.runtime_config。
 * 对齐平台 system_instructions 模板机制；槽位模式由已持久化的开轮结果决定，
 * 不能在 prompt 层根据当前用户偏好重新判断。
 */
export interface EnginePlatformInstructions {
  template: string;
  wordCountTiers: EngineWordCountTiers;
  choiceRules: InstructionSlotRules;
  /** 运营维护的回复风格目录（reply_style_options），按用户 pref_reply_styles 注入模板。 */
  replyStyles: EngineReplyStyle[];
  /** 剧情模式（drive_mode_options）；未配置或损坏时为 null，渲染时注入内置保守规则。 */
  driveModes: DriveModesConfig | null;
}

/** 回复风格的私有部分：marker 是运营写进主体模板的占位符，rules 是开启时替换进去的规则。 */
export interface EngineReplyStyle {
  id: string;
  marker: string;
  rules: string;
  enabled: boolean;
}

export interface EngineInput {
  character: EngineCharacter;
  /**
   * 会话历史，按 turn 升序、同轮 user 在前。
   * 开场白已由 M3b 作为虚拟 turn 0 包含在内：首轮取角色卡，之后取首轮 prompt 快照。
   * 因此引擎**不得**再注入 character.first_mes，否则每轮都会重复一条。
   * 本轮用户输入不在其中，见 userInput。
   * 窗口下界由会话编排按正文字数水位决定，这里已经是截断后的切片，引擎不得再 slice。
   */
  history: EngineHistoryMessage[];
  /**
   * 已渲染好的会话长期记忆（前情提要），作为紧跟角色卡的独立 system 消息。
   */
  storyMemory?: string;
  /**
   * 被窗口截掉的早期轮数，引擎只回填观测字段。未截断或缺省为 0。
   */
  truncatedTurns?: number;
  /**
   * 用户对这张角色卡的设定：补充设定与主角人设。空串表示这一段不出现，两段都空则整条消息不出现。
   * 每轮由生成链路重新读取，不属于历史，因此不受截断与压缩影响。
   */
  userSettings?: EngineUserSettings;
  /** 本轮用户输入原文。引擎负责把平台规则包装在它外面后作为最后一条 user 消息 */
  userInput: string;
  userConfig: UserGenerationConfig;
  slotModes: InstructionSlotModes;
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
   * 被窗口截掉的早期轮数，用于观测。引擎原样回填 input.truncatedTurns，不再二次裁剪。
   */
  truncatedTurns: number;
}

export interface PromptEngine {
  build(input: EngineInput): EngineOutput;
}
