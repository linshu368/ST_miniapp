/**
 * backend / features / engine / render-instructions.ts
 *
 * 平台规则的渲染（M2）。纯函数、无 IO、无 DB。
 *
 * 移植自旧 bot 的两处：
 *   src/features/chat/rules/renderSystemInstructions.ts —— 占位符替换与字数档位查找
 *   src/features/chat/usecases/SimpleChat.ts 的 _buildEnhancedPrompt() —— 包装用户输入的格式
 *
 * 方案：docs/ST_remove-MVP实施方案.md §六。
 */

import {
  RICH_REPLY_PROTOCOL_INSTRUCTIONS,
  type ReplyStylePreferences,
  type UserGenerationConfig,
} from '@miniapp/shared';
import type {
  EnginePlatformInstructions,
  EngineReplyStyle,
  EngineWordCountTiers,
  InstructionSlotMode,
  InstructionSlotModes,
} from './types.js';
import { selectDriveRules } from './drive-mode.js';

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 回复风格注入：模板里的 marker 换成用户已开启风格的规则，其余 marker 一律清空，
 * 绝不把占位符原样发给模型。用户开启了、但 marker 没写进模板（或没填 marker）的风格，
 * 规则追加在模板末尾，保证开关一定生效。
 *
 * 一次正则扫描完成全部替换：先替换进去的规则里即使含有别的 marker，也不会被二次展开。
 * 风格按生成时的用户偏好取值，重新生成会用当前开关。
 */
export function applyReplyStyles(
  template: string,
  styles: readonly EngineReplyStyle[],
  preferences: ReplyStylePreferences | undefined
): string {
  const replacements = new Map<string, string>();
  const unplaced: string[] = [];

  for (const style of styles) {
    const active = style.enabled && preferences?.[style.id] === true && style.rules !== '';
    if (style.marker !== '' && template.includes(style.marker)) {
      replacements.set(style.marker, active ? style.rules : '');
    } else if (active) {
      unplaced.push(style.rules);
    }
  }

  let rendered = template;
  if (replacements.size > 0) {
    const pattern = new RegExp(
      [...replacements.keys()]
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp)
        .join('|'),
      'g'
    );
    rendered = template.replace(pattern, (marker) => replacements.get(marker) ?? '');
  }
  return unplaced.length > 0 ? `${rendered}\n\n${unplaced.join('\n\n')}` : rendered;
}

function selectSlotRules(
  rules: EnginePlatformInstructions['choiceRules'],
  mode: InstructionSlotMode
): string {
  switch (mode) {
    case 'full':
      return rules.on_first_two_turns;
    case 'concise':
      return rules.on_later_turns;
    case 'off':
      return rules.off;
  }
}

/**
 * 渲染平台规则模板。模式来自同一逻辑轮持久化的 RPC 结果；不得读取当前开关
 * 或重新消耗窗口，以确保同轮重生成稳定。
 */
export function renderPlatformInstructions(
  instructions: EnginePlatformInstructions,
  userConfig: UserGenerationConfig,
  slotModes: InstructionSlotModes
): string {
  const wordCountValue = resolveWordCountPromptValue(
    userConfig.pref_word_count,
    instructions.wordCountTiers
  );

  const customInstructions =
    userConfig.pref_custom_instructions?.trim() || EMPTY_CUSTOM_INSTRUCTIONS;

  // 先处理运营写的风格 marker，最后才填用户自由文本，用户文本里的同名字符串不会被展开。
  let rendered = applyReplyStyles(
    instructions.template,
    instructions.replyStyles,
    userConfig.pref_reply_styles
  );
  rendered = replaceAll(
    rendered,
    /\{\{DRIVE_RULES\}\}/g,
    selectDriveRules(instructions.driveModes, userConfig.pref_drive_mode).rules
  );
  rendered = replaceAll(
    rendered,
    /\{\{CHOICE_RULES\}\}/g,
    selectSlotRules(instructions.choiceRules, slotModes.choice)
  );
  // 已退役的状态栏、记忆栏占位：回滚到旧版模板时也只渲染为空，不把占位原样送给模型。
  rendered = replaceAll(rendered, /\{\{(?:STATUS|MEMORY)_RULES\}\}/g, '');
  rendered = replaceAll(rendered, /\{\{WORD_COUNT\}\}/g, wordCountValue);
  rendered = replaceAll(rendered, /\{\{USER_CUSTOM_INSTRUCTIONS\}\}/g, customInstructions);

  // Admin controls content depth, while this versioned constant remains the
  // single machine grammar. Avoid duplicating it for the built-in template.
  return rendered.includes(RICH_REPLY_PROTOCOL_INSTRUCTIONS)
    ? rendered
    : `${rendered}\n\n${RICH_REPLY_PROTOCOL_INSTRUCTIONS}`;
}

/**
 * 平台规则包装本轮用户输入，产物就是 messages 的最后一条 user 消息。
 * 格式逐字移植 bot 的 _buildEnhancedPrompt，改动会直接影响输出质量。
 */
export function wrapUserInput(userInput: string, renderedInstructions: string): string {
  return `##系统指令：以下为最高优先级指令。\n${renderedInstructions}\n##用户指令:${userInput}\n`;
}
