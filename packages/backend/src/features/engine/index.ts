/**
 * backend / features / engine / index.ts
 *
 * Prompt 引擎（M2）对 backend 内部的出口。M3b 只需要这里的东西：
 *   fetchPlatformInstructions() 取平台规则 → 拼 EngineInput → promptEngine.build() 得 messages。
 */

export type {
  EngineCharacter,
  EngineHistoryMessage,
  EngineInput,
  EngineMessage,
  EngineOutput,
  EnginePlatformInstructions,
  EngineReplyStyle,
  EngineWordCountTiers,
  PromptEngine,
} from './types.js';

export { buildPrompt, promptEngine } from './prompt-engine.js';

export {
  applyReplyStyles,
  EMPTY_CUSTOM_INSTRUCTIONS,
  renderPlatformInstructions,
  resolveWordCountPromptValue,
  wrapUserInput,
} from './render-instructions.js';

export { selectDriveRules } from './drive-mode.js';

export {
  engineWordCountTiersToConfig,
  fetchPlatformInstructions,
  invalidatePlatformInstructionsCache,
  parseWordCountTiers,
  PLATFORM_INSTRUCTIONS_TEMPLATE_KEY,
  REPLY_STYLE_OPTIONS_KEY,
  toPublicWordCountTiersFromEngine,
  WORD_COUNT_TIERS_KEY,
  type PlatformInstructionsSnapshot,
} from './platform-instructions.js';
