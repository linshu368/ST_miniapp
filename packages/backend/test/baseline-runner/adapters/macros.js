/**
 * Step 0 adapter: substituteParams baseline.
 *
 * Usage (paste in ST devtools console after ST has loaded and the home
 * screen / any chat is visible):
 *
 *   import('/baseline-runner/adapters/macros.js').then(m => m.run())
 *
 * The adapter:
 *   1. Loads cases from /baseline-runner/fixtures/macros/cases/.
 *   2. Backs up the relevant ST globals once at the start.
 *   3. For each case:
 *        a. Mutates ST globals to reflect the case input
 *           (push synthetic character, reset chat[] / chat_metadata,
 *           set persona_description, point this_chid via setCharacterId).
 *        b. Wraps eval in withDeterministicEnv (seed + moment.now mocks).
 *        c. Calls MacroEnvBuilder.buildFromRawEnv + MacroEngine.evaluate
 *           directly. This is the same path substituteParams takes when
 *           the experimental flag is on; calling them directly lets us
 *           snapshot env for diff localization.
 *   4. Restores ST globals once at the end.
 *   5. Downloads a baseline JSON.
 */

import { runStep, withDeterministicEnv, captureConsole, snapshotJsonSafe } from '../harness.js';
import {
  chat,
  chat_metadata,
  characters,
  name1,
  name2,
  setCharacterId,
  setCharacterName,
  setUserName,
} from '/script.js';
import { power_user } from '/scripts/power-user.js';
import { seedrandom } from '/lib.js';
import { MacroEngine } from '/scripts/macros/engine/MacroEngine.js';
import { MacroEnvBuilder } from '/scripts/macros/engine/MacroEnvBuilder.js';
import { MacroRegistry } from '/scripts/macros/engine/MacroRegistry.js';

// ─── Public entrypoint ──────────────────────────────────────────────────────

export async function run() {
  return runStep('macros', {
    setupOnce: setupGlobalState,
    runOneCase,
    teardownOnce: restoreGlobalState,
    notes: 'Step 0 baseline: MacroEngine.evaluate over MacroEnvBuilder.buildFromRawEnv',
  });
}

// ─── Once-per-run state management ──────────────────────────────────────────

const GLOBAL_BACKUP = {};

function setupGlobalState() {
  GLOBAL_BACKUP.experimentalFlag = power_user?.experimental_macro_engine;
  GLOBAL_BACKUP.persona = power_user?.persona_description;
  GLOBAL_BACKUP.chat = [...chat];
  GLOBAL_BACKUP.chatMetadata = { ...chat_metadata };
  GLOBAL_BACKUP.characters = [...characters];
  GLOBAL_BACKUP.thisChidValue = readThisChid();
  // name1 / name2 are live ESM bindings — read once for restore.
  GLOBAL_BACKUP.name1 = name1;
  GLOBAL_BACKUP.name2 = name2;

  // The new MacroEngine path is gated behind this flag in production
  // (substituteParams checks it). We're calling the engine directly so this
  // is mostly a safety belt for any code paths that re-check the flag.
  if (power_user) power_user.experimental_macro_engine = true;
}

function restoreGlobalState() {
  if (power_user) {
    power_user.experimental_macro_engine = GLOBAL_BACKUP.experimentalFlag;
    power_user.persona_description = GLOBAL_BACKUP.persona;
  }
  resetArrayInPlace(chat, GLOBAL_BACKUP.chat ?? []);
  resetObjectInPlace(chat_metadata, GLOBAL_BACKUP.chatMetadata ?? {});
  resetArrayInPlace(characters, GLOBAL_BACKUP.characters ?? []);
  setCharacterId(GLOBAL_BACKUP.thisChidValue);
  // Restore name1 / name2 globals last so the debounced saveSettings (queued
  // by per-case setUserName calls) ultimately persists the original value.
  setUserName(GLOBAL_BACKUP.name1, { toastPersonaNameChange: false });
  setCharacterName(GLOBAL_BACKUP.name2);
}

// ─── Per-case execution ─────────────────────────────────────────────────────

/**
 * @param {object} caseObj  // { caseId, description, input }
 * @returns {Promise<{ text: string, meta: object }>}
 */
async function runOneCase(caseObj) {
  const input = caseObj.input;

  // 1) Build a synthetic ST-shaped character and inject it at characters[end].
  const synthChar = caseToStCharacter(
    input.character ?? {},
    input.chatMetadata?.chatId ?? `${caseObj.caseId}-chat`
  );
  const syntheticChid = characters.length;
  characters.push(synthChar);
  const prevChid = readThisChid();
  setCharacterId(syntheticChid);

  // 1b) Align ST globals name1 / name2 with this case so that any nested
  //     substituteParams call inside getCharacterCardFieldsLazy (e.g. via
  //     baseChatReplace) sees the correct names. Without this, fields like
  //     {{mesExamplesRaw}} would secondary-substitute {{user}}/{{char}} in
  //     the example dialog using ST defaults ("User" / "SillyTavern System").
  const caseUserName = input.options?.name1Override ?? input.user?.name ?? '';
  const caseCharName = input.options?.name2Override ?? input.character?.name ?? '';
  setUserName(caseUserName, { toastPersonaNameChange: false });
  setCharacterName(caseCharName);

  // 2) Reset chat[] and chat_metadata to per-case values.
  resetArrayInPlace(chat, caseChatToStChat(input.chat?.messages ?? []));
  resetObjectInPlace(chat_metadata, {
    ...input.chatMetadata,
    // ST internally uses snake_case for this field.
    pick_reroll_seed: input.chatMetadata?.pickRerollSeed ?? null,
    variables: structuredClone(input.chatMetadata?.variables ?? {}),
  });

  // 3) {{persona}} reads power_user.persona_description, NOT character.persona.
  //    Merge convention: per-character override > user default.
  if (power_user) {
    power_user.persona_description =
      input.character?.persona || input.user?.personaDescription || '';
  }

  // 4) Build ctx (same shape substituteParams builds internally).
  const ctx = {
    content: input.template,
    name1Override: input.options?.name1Override ?? input.user?.name ?? null,
    name2Override: input.options?.name2Override ?? input.character?.name ?? null,
    original: input.options?.original ?? null,
    groupOverride: input.options?.groupOverride ?? null,
    replaceCharacterCard: input.options?.replaceCharacterCard ?? true,
    dynamicMacros: input.options?.dynamicMacros ?? {},
    postProcessFn: (x) => x,
  };

  // 5) Track which macros got resolved during this case.
  const macrosUsed = new Set();
  const stopTracker = trackMacroUsage(macrosUsed);

  // 5b) Replace {{random}}'s handler with a deterministic version for the
  //     duration of this case. See installDeterministicRandomShim below for
  //     why this is necessary — short version: ST's random uses
  //     seedrandom('added entropy.', { entropy: true }) which reads from a
  //     module-private entropy pool that drifts forever across the page
  //     lifetime, defeating any seed/Math.random/crypto-level mock.
  const restoreRandom = installDeterministicRandomShim(input.options?.seed ?? '');

  let env;
  let text = '';
  let warnings = [];
  try {
    const wrapped = await captureConsole(() =>
      withDeterministicEnv(
        { seed: input.options?.seed ?? null, isoNow: input.options?.now ?? null },
        () => {
          env = MacroEnvBuilder.buildFromRawEnv(ctx);
          return MacroEngine.evaluate(input.template, env);
        }
      )
    );
    text = wrapped.result;
    warnings = wrapped.warnings.filter((w) => /macro/i.test(w));
  } finally {
    restoreRandom();
    stopTracker();
    // Per-case rollback: pop the synthetic character and restore chid.
    // (A full restore of chat / chat_metadata / persona happens in
    // teardownOnce — we don't bother per-case because each case fully
    // overwrites those at step 2/3 above.)
    characters.pop();
    setCharacterId(prevChid);
  }

  return {
    text,
    meta: {
      macrosUsed: [...macrosUsed].sort(),
      warnings,
      envSnapshot: snapshotMacroEnv(env),
    },
  };
}

// ─── Adapters helpers ───────────────────────────────────────────────────────

/**
 * Wraps MacroRegistry.executeMacro to record every macro that was actually
 * invoked during evaluation. executeMacro is the single entry point the
 * engine uses to run a registered (or dynamic-overridden) macro, so this
 * captures the true "macros used" set without false positives from lookups
 * on non-existent names.
 *
 * @param {Set<string>} sink
 * @returns {() => void}
 */
function trackMacroUsage(sink) {
  const orig = MacroRegistry.executeMacro.bind(MacroRegistry);
  MacroRegistry.executeMacro = (call, opts) => {
    if (call && typeof call.name === 'string') sink.add(call.name.toLowerCase());
    return orig(call, opts);
  };
  return () => {
    MacroRegistry.executeMacro = orig;
  };
}

/**
 * Replaces the {{random}} macro handler with a deterministic, position-stable
 * version for the duration of one case. Returns a restore() callback that
 * puts the original handler back.
 *
 * Why this exists
 * ---------------
 * ST's {{random}} macro (public/scripts/macros/definitions/core-macros.js)
 * resolves with:
 *
 *   const rng = seedrandom('added entropy.', { entropy: true });
 *
 * The seedrandom library has a module-level closure variable `pool` that:
 *   - is XOR-mixed on EVERY seedrandom() call across the entire page
 *     (line 80 of seedrandom.js: mixkey(tostring(arc4.S), pool)),
 *   - is READ as part of the seed when entropy:true is passed
 *     (line 50: flatten([seed, tostring(pool)], 3)),
 *   - is initialized once at module load via mixkey(math.random(), pool)
 *     where math.random() is the BROWSER's auto-seeded RNG at that instant.
 *
 * That pool is closure-private (no API to reset). Re-running the test suite
 * in the same tab (or across tabs / page reloads) drifts {{random}}'s
 * output because pool has been mutated by previous calls (ours, ST's, any
 * extension's) AND starts from a fresh browser entropy on each page load.
 *
 * The harness-level mocks in withDeterministicEnv (Math.random override and
 * crypto.getRandomValues all-zero stub) do NOT fix this:
 *   - Math.random is not called by the random handler at all (output comes
 *     from arc4 driven by seed+pool).
 *   - crypto.getRandomValues is only used by seedrandom's autoseed() path,
 *     which is reached only when seed===null. Here seed is 'added entropy.'
 *     so autoseed is never invoked.
 *
 * Therefore the only viable mock surface is the macro handler itself.
 *
 * Determinism contract
 * --------------------
 * Seed = JSON.stringify([caseSeed, globalOffset, list]). This means:
 *   - Same case + same macro position + same list contents → same output.
 *   - Different position in the same case → different output (matches ST's
 *     "re-rolled every time" semantics in spirit: each macro invocation
 *     gets its own roll, just deterministic per-position).
 *   - Different list contents → different output.
 *
 * The shim mirrors ST's `readSingleArgsRandomList` legacy split so the
 * cases that use {{random:a::b::c}} (single-colon prefix) or comma-separated
 * lists still parse the same way. None of the current 9 step-0 cases hit
 * this path, but future cases might.
 *
 * miniAPP must implement the SAME shim in its test mode for the byte-exact
 * baseline diff to be meaningful. See
 * packages/backend/test/fixtures/macros/README.md for the contract.
 *
 * @param {string} caseSeed - The case-level seed (input.options.seed). Used
 *     as the first dimension of the deterministic seed string. May be ''.
 * @returns {() => void} restore - Restores the original handler.
 */
function installDeterministicRandomShim(caseSeed) {
  const def = MacroRegistry.getMacro('random');
  if (!def) return () => {};
  const origHandler = def.handler;
  def.handler = ({ list, globalOffset }) => {
    if (list.length === 1) {
      list = readSingleArgsRandomList(list[0]);
    }
    if (!list.length) return '';
    const seedString = JSON.stringify([caseSeed ?? '', globalOffset, list]);
    const rng = seedrandom(seedString);
    return list[Math.floor(rng() * list.length)];
  };
  return () => {
    def.handler = origHandler;
  };
}

/**
 * Mirrors ST's private readSingleArgsRandomList in core-macros.js. Used by
 * the random shim so legacy single-arg syntax ({{random:a::b::c}} or
 * {{random:a,b,c}}) is split the same way ST splits it.
 *
 * @param {string} listString
 * @returns {string[]}
 */
function readSingleArgsRandomList(listString) {
  if (listString.includes('::')) {
    return listString.split('::').map((item) => item.trim());
  }
  return listString
    .replace(/\\,/g, '##\uFFFDCOMMA\uFFFD##')
    .split(',')
    .map((item) => item.trim().replace(/##\uFFFDCOMMA\uFFFD##/g, ','));
}

/** Best-effort read of the current this_chid value. */
function readThisChid() {
  // ST's this_chid is `export let` and not directly readable from outside
  // via the imported binding pattern (we'd need it as a named import too).
  // We piggy-back on getCurrentChatId-adjacent state via window.this_chid
  // when available; otherwise fall back to undefined.
  return window.this_chid;
}

/** Converts our case CharacterFields into the ST character object shape. */
function caseToStCharacter(charFields, chatId) {
  return {
    name: charFields.name ?? 'Synthetic',
    description: charFields.description ?? '',
    personality: charFields.personality ?? '',
    scenario: charFields.scenario ?? '',
    mes_example: charFields.mesExample ?? '',
    first_mes: charFields.firstMessage ?? '',
    chat: chatId,
    avatar: '__baseline_runner_synthetic__.png',
    fav: false,
    create_date: '0',
    talkativeness: 0.5,
    data: {
      character_version: charFields.version ?? '',
      system_prompt: charFields.charPrompt ?? '',
      post_history_instructions: charFields.charInstruction ?? '',
      creator_notes: charFields.charCreatorNotes ?? '',
      alternate_greetings: Array.isArray(charFields.alternateGreetings)
        ? charFields.alternateGreetings
        : [],
      extensions: {
        depth_prompt: {
          prompt: charFields.charDepthPrompt ?? '',
          depth: 4,
          role: 'system',
        },
      },
    },
  };
}

/** Converts our case ChatMessage[] into the ST chat[] shape. */
function caseChatToStChat(messages) {
  return messages.map((m) => ({
    name: m.name,
    is_user: !!m.isUser,
    is_system: false,
    mes: m.mes,
    send_date: '0',
    ...(typeof m.swipeId === 'number' ? { swipe_id: m.swipeId } : {}),
    ...(Array.isArray(m.swipes) ? { swipes: m.swipes } : {}),
    ...(m.extra && typeof m.extra === 'object' ? { extra: m.extra } : {}),
  }));
}

/** JSON-safe snapshot of a MacroEnv with character lazy getters resolved. */
function snapshotMacroEnv(env) {
  if (!env) return {};
  const character = {};
  if (env.character && typeof env.character === 'object') {
    for (const key of Object.keys(env.character)) {
      try {
        const v = env.character[key];
        character[key] = typeof v === 'function' ? v() : v;
      } catch (e) {
        character[key] = `[Throws: ${e?.message ?? e}]`;
      }
    }
  }
  return snapshotJsonSafe({
    names: env.names,
    character,
    system: env.system,
    contentHash: env.contentHash,
    dynamicMacroKeys: Object.keys(env.dynamicMacros ?? {}),
  });
}

// ─── In-place mutation primitives ────────────────────────────────────────────

function resetArrayInPlace(arr, next) {
  arr.length = 0;
  if (Array.isArray(next)) for (const v of next) arr.push(v);
}

function resetObjectInPlace(obj, next) {
  for (const k of Object.keys(obj)) delete obj[k];
  if (next && typeof next === 'object') Object.assign(obj, next);
}
