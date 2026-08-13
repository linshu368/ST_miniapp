/**
 * backend / features / engine / render-instructions.ts
 *
 * 平台规则的渲染（M2）。纯函数、无 IO、无 DB。
 *
 * 移植自旧 bot 的两处：
 *   src/features/chat/rules/renderSystemInstructions.ts —— 三个占位符的替换与字数档位查找
 *   src/features/chat/usecases/SimpleChat.ts 的 _buildEnhancedPrompt() —— 包装用户输入的格式
 *
 * 方案：docs/ST_remove-MVP实施方案.md §六。
 */

import type { UserGenerationConfig } from '@miniapp/shared';
import type { EnginePlatformInstructions, EngineWordCountTiers } from './types.js';

/** pref_custom_instructions 为空时注入模板的占位文案，与 bot 一致 */
export const EMPTY_CUSTOM_INSTRUCTIONS = '暂无';

/**
 * 把用户选择的字数档位 id 翻成注入 {{WORD_COUNT}} 的文案。
 *
 * 只在 enabled 档位里按 id 匹配；未命中（下线 / 旧值 / 拼写错误）回落到 defaultTierId 对应档位的
 * promptValue，再不行用配置里的 defaultTierId 字符串本身兜底。
 */
export function resolveWordCountPromptValue(
  wordCountId: string,
  tiersConfig: EngineWordCountTiers
): string {
  const enabled = tiersConfig.tiers.filter((tier) => tier.enabled);
  const matched = enabled.find((tier) => tier.id === wordCountId);
  if (matched) return matched.promptValue;

  const fallback =
    enabled.find((tier) => tier.id === tiersConfig.defaultTierId) ??
    tiersConfig.tiers.find((tier) => tier.id === tiersConfig.defaultTierId) ??
    enabled[0];
  return fallback?.promptValue ?? tiersConfig.defaultTierId;
}

/**
 * 用 String.replace 的函数式 replacement，避开 $& / $1 / $` 这些替换模式。
 * pref_custom_instructions 是用户自由文本，用字符串 replacement 会让 `$&` 展开成整个匹配串。
 * bot 侧有这个坑，移植时顺手堵上——正常文本下行为完全一致。
 */
function replaceAll(source: string, placeholder: RegExp, value: string): string {
  return source.replace(placeholder, () => value);
}

/**
 * 渲染平台规则模板。三个占位符全局替换，替换顺序与 bot 一致
 * （先 WORD_COUNT、再 INTERACTION_MODE、最后 USER_CUSTOM_INSTRUCTIONS）。
 */
export function renderPlatformInstructions(
  instructions: EnginePlatformInstructions,
  userConfig: UserGenerationConfig
): string {
  const interactionModeBlock = userConfig.pref_show_options
    ? instructions.interactionModeBlocks.optionsOn
    : instructions.interactionModeBlocks.optionsOff;

  const wordCountValue = resolveWordCountPromptValue(
    userConfig.pref_word_count,
    instructions.wordCountTiers
  );

  const customInstructions =
    userConfig.pref_custom_instructions?.trim() || EMPTY_CUSTOM_INSTRUCTIONS;

  let rendered = replaceAll(instructions.template, /\{\{WORD_COUNT\}\}/g, wordCountValue);
  rendered = replaceAll(rendered, /\{\{INTERACTION_MODE\}\}/g, interactionModeBlock);
  return replaceAll(rendered, /\{\{USER_CUSTOM_INSTRUCTIONS\}\}/g, customInstructions);
}

/**
 * 平台规则包装本轮用户输入，产物就是 messages 的最后一条 user 消息。
 * 格式逐字移植 bot 的 _buildEnhancedPrompt，改动会直接影响输出质量。
 */
export function wrapUserInput(userInput: string, renderedInstructions: string): string {
  return `##系统指令：以下为最高优先级指令。\n${renderedInstructions}\n##用户指令:${userInput}\n`;
}
