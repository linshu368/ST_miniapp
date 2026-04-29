/**
 * substituteParams.ts
 *
 * The ONLY public entry point for the macro engine on the backend.
 * Mirrors SillyTavern's `script.js:2923 substituteParams(content, options)`,
 * but takes an explicit `ctx` argument instead of reading module-level
 * globals from the browser.
 *
 * Internally:
 *   1. Lazy-loads the JS macro engine (`./macros/macro-system.js`) and
 *      runs `initRegisterMacros()` exactly once.
 *   2. Patches the host shim (`./macros/runtime/host.js`) with the
 *      caller-supplied ctx fields (chat / chat_metadata / name1 / name2
 *      / characters / power_user / etc.).
 *   3. Builds a MacroEnv via `MacroEnvBuilder.buildFromRawEnv` and
 *      evaluates the template via `MacroEngine.evaluate`.
 *   4. Restores the previous host state, even on exception.
 *
 * The engine subtree (`./macros/**`) is intentionally `.js + JSDoc` so
 * we can keep it byte-close to ST. This file is the only TS surface
 * the rest of the backend (`packages/backend/src/**`) ever imports.
 */

import { MacroEngine, MacroEnvBuilder, initRegisterMacros } from './macros/macro-system.js';
import { setRuntimeCtx, resetRuntimeCtx } from './macros/runtime/host.js';
import { setGlobalStore } from './macros/runtime/variables.js';

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Power-user fields that the macro engine reads. Only the fields
 * touched in Step 0 are listed; future steps will extend this.
 */
export interface PowerUserShape {
  persona_description?: string;
  experimental_macro_engine?: boolean;
  prefer_character_prompt?: boolean;
  prefer_character_jailbreak?: boolean;
  collapse_newlines?: boolean;
  instruct?: { enabled?: boolean };
  sysprompt?: { enabled?: boolean };
  context?: { example_separator?: string };
  // Allow extension fields we don't model yet without a TS error.
  [key: string]: unknown;
}

/**
 * Caller-supplied context for one substituteParams() invocation.
 * All fields are optional — sensible defaults are documented inline.
 */
export interface SubstituteCtx {
  /** Active chat history. Default: []. */
  chat?: unknown[];
  /** Chat-scoped metadata (variables, pick_reroll_seed, scenario, …). Default: {}. */
  chatMetadata?: Record<string, unknown>;
  /** ST main_api ('openai' | 'textgenerationwebui' | …). Default: ''. */
  mainApi?: string;
  /** User name (drives {{user}}). Default: ''. */
  name1?: string;
  /** Character name (drives {{char}}). Default: ''. */
  name2?: string;
  /** Loaded character cards. Default: []. */
  characters?: unknown[];
  /** 0-based index into `characters` for the current speaker; -1 = none. Default: -1. */
  thisChid?: number;
  /** ST groups list (Step 0: unused, default []). */
  groups?: unknown[];
  /** ST selected_group id (Step 0: unused, default null). */
  selectedGroup?: string | null;
  /** power_user subset (see PowerUserShape). Default: built-in skeleton. */
  powerUser?: PowerUserShape;
  /** extension_prompts key/value bus (used by {{outlet}}). Default: {}. */
  extensionPrompts?: Record<string, { value: string }>;
  /** Live array {{banned}} pushes into. Default: []. */
  bannedTokens?: string[];
  /** Backing store for {{getglobalvar}}/{{setglobalvar}}. Default: {}. */
  globalVariables?: Record<string, unknown>;
  /** Seed for {{input}} (no DOM on backend). Default: ''. */
  userInput?: string;

  // ─── Function pointers (injected with sensible no-op defaults) ───────────

  /** Returns the active chat ID (drives {{pick}} seeding). */
  getCurrentChatId?: () => string;
  /** Returns the model name for {{model}}. */
  getGeneratingModel?: () => string;
  /** Drives {{maxPrompt}} / {{maxPromptTokens}}. */
  getMaxPromptTokens?: () => number;
  /** Drives {{maxContext}} / {{maxContextTokens}}. */
  getMaxContextTokens?: () => number;
  /** Drives {{maxResponse}} / {{maxResponseTokens}}. */
  getMaxResponseTokens?: () => number;
}

/**
 * Per-call options. Same shape as ST 1.17.0's
 * `substituteParams(content, options)`.
 */
export interface SubstituteOptions {
  name1Override?: string | null;
  name2Override?: string | null;
  /** One-shot value returned by {{original}}. */
  original?: string | null;
  /** Forces {{group}} to a specific value (Step 0: unused). */
  groupOverride?: string | null;
  /** Whether character-card macros are replaced. Default true. Set false
   *  for inner baseChatReplace recursion. */
  replaceCharacterCard?: boolean;
  /** Per-call ad-hoc macros (string | function | full def). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dynamicMacros?: Record<string, any>;
  /** Post-processing applied to every macro result. Default: identity. */
  postProcessFn?: (x: string) => string;
}

// ─── Internals ──────────────────────────────────────────────────────────────

let _initialized = false;

function ensureInitialized(): void {
  if (_initialized) return;
  initRegisterMacros();
  _initialized = true;
}

/**
 * Coerce a SubstituteCtx into the patch shape expected by host.js's
 * setRuntimeCtx(). Anything the caller didn't provide is left to the
 * host's own defaults.
 */
function buildHostPatch(
  ctx: SubstituteCtx,
  recursive: (s: string, opts?: SubstituteOptions) => string
): Record<string, unknown> {
  return {
    chat: ctx.chat ?? [],
    chat_metadata: ctx.chatMetadata ?? {},
    main_api: ctx.mainApi ?? '',
    name1: ctx.name1 ?? '',
    name2: ctx.name2 ?? '',
    characters: ctx.characters ?? [],
    groups: ctx.groups ?? [],
    selected_group: ctx.selectedGroup ?? null,
    power_user: ctx.powerUser ?? {},
    extension_prompts: ctx.extensionPrompts ?? {},
    textgenerationwebui_banned_in_macros: ctx.bannedTokens ?? [],
    this_chid: ctx.thisChid ?? -1,
    userInput: ctx.userInput ?? '',
    substituteParams: recursive,
    getCurrentChatId: ctx.getCurrentChatId ?? (() => ''),
    getGeneratingModel: ctx.getGeneratingModel ?? (() => ''),
    getMaxPromptTokens: ctx.getMaxPromptTokens ?? (() => 0),
    getMaxContextTokens: ctx.getMaxContextTokens ?? (() => 0),
    getMaxResponseTokens: ctx.getMaxResponseTokens ?? (() => 0),
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Substitutes {{macros}} in `content`, given an explicit ctx and options.
 *
 * Same algorithm as `script.js:2923 substituteParams` in ST 1.17.0:
 *
 *   1. Build MacroEnv via MacroEnvBuilder.buildFromRawEnv.
 *   2. Evaluate via MacroEngine.evaluate.
 *
 * @param content - The string containing {{macros}}.
 * @param ctx     - Backend-supplied environment (chat / character / settings / …).
 * @param options - Per-call overrides matching ST's substituteParams options.
 * @returns       - The fully substituted string.
 */
export function substituteParams(
  content: string,
  ctx: SubstituteCtx = {},
  options: SubstituteOptions = {}
): string {
  if (!content) return '';

  ensureInitialized();

  // Recursive callback for baseChatReplace (used by getCharacterCardFieldsLazy
  // when {{description}} / {{mesExamplesRaw}} / etc. are read off env.character).
  // Important: `replaceCharacterCard:false` is passed by host.js → baseChatReplace
  // to prevent infinite recursion through the lazy resolvers.
  const recursive = (s: string, opts: SubstituteOptions = {}): string =>
    substituteParams(s, ctx, opts);

  const hostPatch = buildHostPatch(ctx, recursive);
  const hostSnapshot = setRuntimeCtx(hostPatch);
  const prevGlobalStore = setGlobalStore(ctx.globalVariables ?? {});

  try {
    // Build the same env shape ST's substituteParams builds internally.
    const rawEnvCtx = {
      content,
      name1Override: options.name1Override,
      name2Override: options.name2Override,
      original: options.original,
      groupOverride: options.groupOverride,
      replaceCharacterCard: options.replaceCharacterCard ?? true,
      dynamicMacros: options.dynamicMacros ?? {},
      postProcessFn: options.postProcessFn ?? ((x: string) => x),
    };

    const env = MacroEnvBuilder.buildFromRawEnv(rawEnvCtx);
    const result: string = MacroEngine.evaluate(content, env);
    return result;
  } finally {
    setGlobalStore(prevGlobalStore);
    resetRuntimeCtx(hostSnapshot);
  }
}

export default substituteParams;
