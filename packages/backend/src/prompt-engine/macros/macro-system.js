/**
 * macro-system.js
 *
 * Single entry point for the new macro system, mirroring ST's
 * `public/scripts/macros/macro-system.js`. Re-exports the engine
 * singletons + provides `initRegisterMacros()` that wires up all the
 * built-in definition groups in a deterministic order.
 *
 * Step 0 scope: core / env / chat / time / variable.
 * Deferred to Step 1: state-macros (eventSource / extensions) and
 *                    instruct-macros (instruct-mode formatting).
 */

import { MacroEngine } from './engine/MacroEngine.js';
import { MacroRegistry, MacroCategory, MacroValueType } from './engine/MacroRegistry.js';
import { MacroLexer } from './engine/MacroLexer.js';
import { MacroParser } from './engine/MacroParser.js';
import { MacroCstWalker } from './engine/MacroCstWalker.js';
import { MacroEnvBuilder } from './engine/MacroEnvBuilder.js';

import { registerCoreMacros } from './definitions/core-macros.js';
import { registerEnvMacros } from './definitions/env-macros.js';
import { registerChatMacros } from './definitions/chat-macros.js';
import { registerTimeMacros } from './definitions/time-macros.js';
import { registerVariableMacros } from './definitions/variable-macros.js';

export {
  MacroEngine,
  MacroRegistry,
  MacroCategory,
  MacroValueType,
  MacroLexer,
  MacroParser,
  MacroCstWalker,
  MacroEnvBuilder,
};

/** @typedef {import('./engine/MacroRegistry.js').MacroDefinitionOptions} MacroDefinitionOptions */
/** @typedef {import('./engine/MacroRegistry.js').MacroDefinition} MacroDefinition */
/** @typedef {import('./engine/MacroRegistry.js').MacroHandler} MacroHandler */
/** @typedef {import('./engine/MacroRegistry.js').MacroExecutionContext} MacroExecutionContext */
/** @typedef {import('./engine/MacroEnv.types.js').MacroEnv} MacroEnv */
/** @typedef {import('./engine/MacroEnv.types.js').MacroEnvNames} MacroEnvNames */
/** @typedef {import('./engine/MacroEnv.types.js').MacroEnvCharacter} MacroEnvCharacter */

let _registered = false;

/**
 * Idempotently registers all built-in macros for Step 0. Safe to call
 * multiple times — subsequent calls are no-ops.
 */
export function initRegisterMacros() {
  if (_registered) return;
  registerCoreMacros();
  registerEnvMacros();
  registerChatMacros();
  registerTimeMacros();
  registerVariableMacros();
  _registered = true;
}

/**
 * Test-only helper: forces re-registration on next initRegisterMacros() call.
 * Used by unit tests that swap mocks between cases.
 */
export function _resetRegistrationFlag() {
  _registered = false;
}
