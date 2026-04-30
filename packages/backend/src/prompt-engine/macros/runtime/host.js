/**
 * runtime/host.js
 *
 * Replacement for the SillyTavern global module surface that the macro
 * engine reaches into via `import { ... } from '../../../script.js'`,
 * `'../../power-user.js'`, `'../../../scripts/group-chats.js'`, and
 * `'../../textgen-settings.js'`.
 *
 * On ST these are mutable module-level globals the rest of the app
 * patches as state changes. We mirror that shape here using ESM `let`
 * exports — re-assignments inside `setRuntimeCtx()` propagate to every
 * importing module via live bindings, exactly like ST does it.
 *
 * The TypeScript façade (`../substituteParams.ts`) is the ONLY caller
 * of `setRuntimeCtx` / `resetRuntimeCtx`. The engine and definitions
 * themselves only READ from these bindings.
 *
 * 剪线决策（与 plan 中的剪线清单一致）:
 *   - power_user        → caller-injected subset (only persona_description /
 *                         instruct.* / context.example_separator /
 *                         experimental_macro_engine are read in Step 0)
 *   - groups / selected_group → caller-injected, default to []/null
 *   - isMobile()        → hardcoded false (no DOM on backend)
 *   - getUserInput()    → reads from ctx.userInput (replaces
 *                         document.querySelector('#send_textarea'))
 *   - getMaxPromptTokens / getMaxContextTokens / getMaxResponseTokens
 *                       → caller-injected functions, default to 0
 *   - getCurrentChatId  → caller-injected, defaults to chat_metadata.main_chat
 *   - getGeneratingModel → caller-injected, defaults to ''
 *   - getCharacterCardFieldsLazy → ports ST's lazy-resolver pattern;
 *                         baseChatReplace is delegated to the injected
 *                         substituteParams callback (set by the façade)
 *   - parseMesExamples  → NOT ported in Step 0; the {{mesExamples}}
 *                         macro short-circuits to mesExamplesRaw.
 *                         Will be properly ported in Step 1 alongside
 *                         instruct-mode.
 */

// ─── Live bindings (mutated by setRuntimeCtx) ───────────────────────────────

/** @type {Array<any>} */
export let chat = [];
/** @type {Record<string, any>} */
export let chat_metadata = {};
/** @type {string} */
export let main_api = '';
/** @type {string} */
export let name1 = '';
/** @type {string} */
export let name2 = '';
/** @type {Array<any>} */
export let characters = [];
/** @type {Array<any>} */
export let groups = [];
/** @type {string|null} */
export let selected_group = null;
/** @type {Record<string, any>} */
export let power_user = createDefaultPowerUser();
/** @type {Record<string, { value: string, position?: number, depth?: number, role?: string, scan?: boolean }>} */
export let extension_prompts = {};
/** @type {string[]} */
export let textgenerationwebui_banned_in_macros = [];
/** @type {number} this_chid mirrors ST's index-into-characters pointer. */
export let this_chid = -1;

// ─── Internal function pointers (caller-injected) ───────────────────────────

const _hostFns = {
  /** @type {(s: string, opts?: object) => string} */
  substituteParams: (s) => s,
  /** @type {() => number} */
  getMaxPromptTokens: () => 0,
  /** @type {() => number} */
  getMaxContextTokens: () => 0,
  /** @type {() => number} */
  getMaxResponseTokens: () => 0,
  /** @type {() => string} */
  getCurrentChatId: () => chat_metadata?.main_chat ?? '',
  /** @type {() => string} */
  getGeneratingModel: () => '',
  /** @type {string} */
  userInput: '',
};

// ─── Public re-exports (the engine imports these as functions) ──────────────

/** @returns {number} */
export function getMaxPromptTokens() {
  return _hostFns.getMaxPromptTokens();
}
/** @returns {number} */
export function getMaxContextTokens() {
  return _hostFns.getMaxContextTokens();
}
/** @returns {number} */
export function getMaxResponseTokens() {
  return _hostFns.getMaxResponseTokens();
}
/** @returns {string} */
export function getCurrentChatId() {
  return _hostFns.getCurrentChatId();
}
/** @returns {string} */
export function getGeneratingModel() {
  return _hostFns.getGeneratingModel();
}
/** @returns {string} */
export function getUserInput() {
  return _hostFns.userInput ?? '';
}

/**
 * 公共 substituteParams wrapper。Step 1 instruct 子树（以及未来
 * Step 2/3）都通过这条路径调用 macro 引擎，而不是直接 import TS
 * 门面 `../substituteParams.ts`——因为 instruct/* 是纯 .js + JSDoc
 * 子树，跨向 .ts 文件 import 会破坏「engine 子树自给自足」的剪线
 * 不变量。门面 façade 在调用入口处通过 `setRuntimeCtx({ substituteParams })`
 * 把递归回调注入到 _hostFns，下面这个 wrapper 就能拿到 live binding。
 *
 * 与 ST 原版 `import { substituteParams } from '../script.js'` 的
 * 行为完全等价。
 *
 * @param {string} content
 * @param {object} [opts]
 * @returns {string}
 */
export function substituteParams(content, opts) {
  return _hostFns.substituteParams(content, opts);
}

/**
 * Backend has no DOM, so {{isMobile}} is always false.
 * @returns {boolean}
 */
export function isMobile() {
  return false;
}

/**
 * 1:1 移植自 `public/scripts/group-chats.js:337 getGroupNames`。
 * 当未选中 group（selected_group 为 null/空）时返回 `[]`，否则
 * 在 groups 数组里查 id 匹配项，把 members（avatar 列表）映射回
 * characters 里的 name 字段。
 *
 * Step 1 instruct 子树的 parseExampleIntoIndividual 用这个判定
 * group-chat example 块里的 bot 名字前缀。Step 0 baseline 不会
 * 路过这里（selected_group 始终为 null），但保留 ST 完整行为，
 * Step 2/3 接入 group chat 时无需再改。
 *
 * @returns {string[]} group 成员的 character.name 列表
 */
export function getGroupNames() {
  if (!selected_group) {
    return [];
  }
  const groupMembers = groups.find((x) => x.id == selected_group)?.members;
  return Array.isArray(groupMembers)
    ? groupMembers.map((x) => characters.find((y) => y.avatar === x)?.name).filter((x) => x)
    : [];
}

// ─── Character card lazy fields ─────────────────────────────────────────────

/**
 * Mirror of ST's `createLazyFields`. Each property is computed (and
 * baseChatReplace'd) on first access, then memoised.
 *
 * @param {Record<string, () => any>} resolvers
 * @returns {Record<string, any>}
 */
function createLazyFields(resolvers) {
  /** @type {Record<string, any>} */
  const result = {};
  for (const [key, resolver] of Object.entries(resolvers)) {
    let cached;
    let resolved = false;
    Object.defineProperty(result, key, {
      get() {
        if (!resolved) {
          cached = resolver();
          resolved = true;
        }
        return cached;
      },
      enumerable: true,
      configurable: true,
    });
  }
  return result;
}

/**
 * Mirror of ST's `baseChatReplace(value)`:
 *   1. Substitutes macros via the injected substituteParams (with
 *      replaceCharacterCard:false to break the recursion).
 *   2. Optionally collapses newlines (we don't on backend — ST gates
 *      this on `power_user.collapse_newlines`, and our default
 *      power_user has it false to stay byte-equal to the ST baseline).
 *   3. Strips '\r' for cross-platform parity.
 *
 * @param {string|undefined} value
 * @param {string|null} [name1Override]
 * @param {string|null} [name2Override]
 * @returns {string}
 */
function baseChatReplace(value, name1Override = null, name2Override = null) {
  if (typeof value === 'string' && value.length > 0) {
    value = _hostFns.substituteParams(value, {
      name1Override,
      name2Override,
      replaceCharacterCard: false,
    });

    if (power_user?.collapse_newlines) {
      value = value.replace(/\n+/g, '\n');
    }

    value = value.replace(/\r/g, '');
  }
  return value ?? '';
}

/**
 * Returns lazy-evaluated character card fields for the current
 * `this_chid`. Same shape as ST's getCharacterCardFieldsLazy.
 *
 * Behavioural parity highlights for Step 0 baselines:
 *   - persona     → power_user.persona_description (so the test runner's
 *                   "character.persona override > user persona" merge is
 *                   honoured by setting power_user.persona_description on
 *                   the way in)
 *   - description / personality / scenario / mesExamples → from
 *                   character.* with baseChatReplace applied (this is
 *                   what makes {{mesExamplesRaw}} contain literal
 *                   "{{user}}" → "宋砚" in case 9)
 *
 * Group chats are not supported in Step 0 (the cut list defers them);
 * `groupCardsLazy` is always null here.
 *
 * @returns {Record<string, any>|null}
 */
export function getCharacterCardFieldsLazy() {
  const character = characters[this_chid] ?? null;

  /** @type {Record<string, () => any>} */
  const resolvers = {
    persona: () => baseChatReplace(power_user?.persona_description?.trim()),
    system: () => {
      if (!character) return '';
      const systemPrompt = chat_metadata?.system_prompt || character.data?.system_prompt || '';
      return power_user?.prefer_character_prompt ? baseChatReplace(systemPrompt.trim()) : '';
    },
    jailbreak: () => {
      if (!character) return '';
      return power_user?.prefer_character_jailbreak
        ? baseChatReplace(character.data?.post_history_instructions?.trim())
        : '';
    },
    version: () => character?.data?.character_version ?? '',
    charDepthPrompt: () => {
      if (!character) return '';
      return baseChatReplace(character.data?.extensions?.depth_prompt?.prompt?.trim());
    },
    creatorNotes: () => {
      if (!character) return '';
      return baseChatReplace(character.data?.creator_notes?.trim());
    },
    description: () => {
      if (!character) return '';
      return baseChatReplace(character.description?.trim());
    },
    personality: () => {
      if (!character) return '';
      return baseChatReplace(character.personality?.trim());
    },
    scenario: () => {
      if (!character) return '';
      const scenarioText = chat_metadata?.scenario || character.scenario || '';
      return baseChatReplace(scenarioText.trim());
    },
    mesExamples: () => {
      if (!character) return '';
      const exampleDialog = chat_metadata?.mes_example || character.mes_example || '';
      return baseChatReplace(exampleDialog.trim());
    },
    firstMessage: () => {
      if (!character) return '';
      const firstMes = character.first_mes?.trim() || '';
      return baseChatReplace(firstMes);
    },
    alternateGreetings: () => {
      if (!character) return [];
      const altGreetings = character.data?.alternate_greetings;
      if (!Array.isArray(altGreetings)) return [];
      return altGreetings.map((g) => baseChatReplace(g?.trim()));
    },
  };

  return createLazyFields(resolvers);
}

/**
 * Stub for parseMesExamples. Properly ported in Step 1 alongside
 * instruct-mode. The {{mesExamples}} macro short-circuits to raw in
 * Step 0, so this is unreachable from any of the 9 baseline cases.
 *
 * @param {string} _examplesStr
 * @param {boolean} _isInstruct
 * @returns {string[]}
 */
export function parseMesExamples(_examplesStr, _isInstruct) {
  return [];
}

// ─── ctx mutators (called by the TS façade) ─────────────────────────────────

/**
 * Default skeleton for an InstructSettings object.
 *
 * Step 1 widens the surface from `{ enabled: false }` to the full
 * field set so any `power_user.instruct.<field>` access in ported
 * instruct-mode code returns a sensibly-typed value instead of
 * `undefined` (which would, e.g., break `.replace(/{{name}}/, ...)`).
 *
 * IMPORTANT — Step 0 byte-equal invariant:
 *   - `enabled` MUST stay `false` here. The Step 0 baseline runs
 *     under "instruct disabled" semantics; flipping this would change
 *     `getInstructMacros` paths once that's registered.
 *   - All other defaults are pure shape padding. They are visible only
 *     when a caller fails to pass `customInstruct` AND fails to set
 *     `power_user.instruct.*` via setRuntimeCtx — neither of which
 *     happens in any Step 0 fixture (every fixture either patches
 *     power_user explicitly or never touches instruct).
 *   - `setRuntimeCtx({ power_user: { instruct: {...} } })` does a
 *     SHALLOW merge at the top level, so a caller-supplied `instruct`
 *     object fully REPLACES this skeleton. We rely on that to keep
 *     the contract "what you pass is what you get".
 *
 * Default values mirror what `migrateInstructModeSettings` in
 * `instruct-mode.js:71` would backfill onto a freshly imported
 * legacy preset, with two deviations:
 *   - `names_behavior: 'none'` instead of `'force'` (we want a default
 *     skeleton to read as "nothing is enabled"; ST's `'force'` default
 *     is a migration bias for legacy presets, not a true neutral).
 *   - `sequences_as_stop_strings: true` matches ST's migration default.
 */
function createDefaultInstruct() {
  return {
    enabled: false,
    wrap: false,
    macro: false,
    names_behavior: 'none',
    input_sequence: '',
    input_suffix: '',
    output_sequence: '',
    output_suffix: '',
    system_sequence: '',
    system_suffix: '',
    last_system_sequence: '',
    first_input_sequence: '',
    last_input_sequence: '',
    first_output_sequence: '',
    last_output_sequence: '',
    stop_sequence: '',
    story_string_prefix: '',
    story_string_suffix: '',
    user_alignment_message: '',
    system_same_as_user: false,
    sequences_as_stop_strings: true,
    activation_regex: '',
    bind_to_context: false,
    skip_examples: false,
  };
}

/**
 * Default skeleton for a ContextSettings object. Mirrors the
 * `power_user.context.*` fields read by Step 1 instruct functions
 * and `getInstructStoppingSequences`. story_string_position defaults
 * to 0 (= extension_prompt_types.IN_PROMPT) which is ST's own default
 * for a freshly-loaded chat with no preset.
 */
function createDefaultContext() {
  return {
    preset: '',
    story_string_position: 0,
    chat_start: '',
    example_separator: '',
    use_stop_strings: false,
  };
}

/**
 * Default skeleton for a SyspromptSettings object. Step 1's
 * `getInstructMacros` reads `sysprompt.enabled` and `sysprompt.content`
 * to decide whether the {{systemPrompt}} family of macros emits
 * anything. Step 0 only reads `enabled` (always false here).
 */
function createDefaultSysprompt() {
  return {
    enabled: false,
    content: '',
  };
}

/**
 * Default skeleton for power_user. Step 0 only reads
 * `persona_description`, `experimental_macro_engine`,
 * `prefer_character_*`, `collapse_newlines`,
 * `instruct.enabled`, `sysprompt.enabled`, `context.example_separator`;
 * the wider Step 1 surface (full instruct, context, sysprompt field
 * sets) is documented in the per-section helpers above and never read
 * on Step 0 baseline paths.
 *
 * Callers override via setRuntimeCtx({ power_user: ... }). The merge
 * is SHALLOW at the top level: a caller-supplied `instruct` object
 * fully replaces the skeleton's `instruct`, ditto `context` and
 * `sysprompt` — there's no per-field deep merge.
 */
function createDefaultPowerUser() {
  return {
    persona_description: '',
    experimental_macro_engine: true,
    prefer_character_prompt: false,
    prefer_character_jailbreak: false,
    collapse_newlines: false,
    instruct: createDefaultInstruct(),
    sysprompt: createDefaultSysprompt(),
    context: createDefaultContext(),
  };
}

/**
 * Snapshot returned by setRuntimeCtx — the façade saves it and passes
 * it to resetRuntimeCtx() afterwards to fully restore the previous
 * state. This makes nested / parallel substituteParams() calls safe
 * even when a caller forgot to clean up.
 *
 * @typedef {Object} HostCtxSnapshot
 * @property {Array<any>} chat
 * @property {Record<string, any>} chat_metadata
 * @property {string} main_api
 * @property {string} name1
 * @property {string} name2
 * @property {Array<any>} characters
 * @property {Array<any>} groups
 * @property {string|null} selected_group
 * @property {Record<string, any>} power_user
 * @property {Record<string, any>} extension_prompts
 * @property {string[]} textgenerationwebui_banned_in_macros
 * @property {number} this_chid
 * @property {typeof _hostFns} fns
 */

/**
 * @typedef {Object} HostCtxPatch
 * @property {Array<any>} [chat]
 * @property {Record<string, any>} [chat_metadata]
 * @property {string} [main_api]
 * @property {string} [name1]
 * @property {string} [name2]
 * @property {Array<any>} [characters]
 * @property {Array<any>} [groups]
 * @property {string|null} [selected_group]
 * @property {Record<string, any>} [power_user]
 * @property {Record<string, any>} [extension_prompts]
 * @property {string[]} [textgenerationwebui_banned_in_macros]
 * @property {number} [this_chid]
 * @property {(s: string, opts?: object) => string} [substituteParams]
 * @property {() => number} [getMaxPromptTokens]
 * @property {() => number} [getMaxContextTokens]
 * @property {() => number} [getMaxResponseTokens]
 * @property {() => string} [getCurrentChatId]
 * @property {() => string} [getGeneratingModel]
 * @property {string} [userInput]
 */

/**
 * Patch the host's mutable state. Returns a snapshot the caller can
 * pass to resetRuntimeCtx() afterwards.
 *
 * @param {HostCtxPatch} patch
 * @returns {HostCtxSnapshot}
 */
export function setRuntimeCtx(patch) {
  /** @type {HostCtxSnapshot} */
  const snapshot = {
    chat,
    chat_metadata,
    main_api,
    name1,
    name2,
    characters,
    groups,
    selected_group,
    power_user,
    extension_prompts,
    textgenerationwebui_banned_in_macros,
    this_chid,
    fns: { ..._hostFns },
  };

  if (patch.chat !== undefined) chat = patch.chat;
  if (patch.chat_metadata !== undefined) chat_metadata = patch.chat_metadata;
  if (patch.main_api !== undefined) main_api = patch.main_api;
  if (patch.name1 !== undefined) name1 = patch.name1;
  if (patch.name2 !== undefined) name2 = patch.name2;
  if (patch.characters !== undefined) characters = patch.characters;
  if (patch.groups !== undefined) groups = patch.groups;
  if (patch.selected_group !== undefined) selected_group = patch.selected_group;
  if (patch.power_user !== undefined)
    power_user = { ...createDefaultPowerUser(), ...patch.power_user };
  if (patch.extension_prompts !== undefined) extension_prompts = patch.extension_prompts;
  if (patch.textgenerationwebui_banned_in_macros !== undefined)
    textgenerationwebui_banned_in_macros = patch.textgenerationwebui_banned_in_macros;
  if (patch.this_chid !== undefined) this_chid = patch.this_chid;

  if (patch.substituteParams) _hostFns.substituteParams = patch.substituteParams;
  if (patch.getMaxPromptTokens) _hostFns.getMaxPromptTokens = patch.getMaxPromptTokens;
  if (patch.getMaxContextTokens) _hostFns.getMaxContextTokens = patch.getMaxContextTokens;
  if (patch.getMaxResponseTokens) _hostFns.getMaxResponseTokens = patch.getMaxResponseTokens;
  if (patch.getCurrentChatId) _hostFns.getCurrentChatId = patch.getCurrentChatId;
  if (patch.getGeneratingModel) _hostFns.getGeneratingModel = patch.getGeneratingModel;
  if (patch.userInput !== undefined) _hostFns.userInput = patch.userInput;

  return snapshot;
}

/**
 * Restore from a snapshot taken by setRuntimeCtx().
 *
 * @param {HostCtxSnapshot} snapshot
 * @returns {void}
 */
export function resetRuntimeCtx(snapshot) {
  chat = snapshot.chat;
  chat_metadata = snapshot.chat_metadata;
  main_api = snapshot.main_api;
  name1 = snapshot.name1;
  name2 = snapshot.name2;
  characters = snapshot.characters;
  groups = snapshot.groups;
  selected_group = snapshot.selected_group;
  power_user = snapshot.power_user;
  extension_prompts = snapshot.extension_prompts;
  textgenerationwebui_banned_in_macros = snapshot.textgenerationwebui_banned_in_macros;
  this_chid = snapshot.this_chid;
  Object.assign(_hostFns, snapshot.fns);
}
