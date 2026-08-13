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
  EngineWordCountTiers,
  PromptEngine,
} from './types.js';

export { buildPrompt, promptEngine } from './prompt-engine.js';

export {
  EMPTY_CUSTOM_INSTRUCTIONS,
  renderPlatformInstructions,
  resolveWordCountPromptValue,
  wrapUserInput,
} from './render-instructions.js';

export {
  engineWordCountTiersToConfig,
  fetchPlatformInstructions,
  invalidatePlatformInstructionsCache,
  INTERACTION_MODE_BLOCKS_KEY,
  parseWordCountTiers,
  PLATFORM_INSTRUCTIONS_TEMPLATE_KEY,
  toPublicWordCountTiersFromEngine,
  WORD_COUNT_TIERS_KEY,
  type PlatformInstructionsSnapshot,
} from './platform-instructions.js';
