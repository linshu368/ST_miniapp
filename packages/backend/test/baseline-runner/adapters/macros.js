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
import { chat, chat_metadata, characters, setCharacterId } from '/script.js';
import { power_user } from '/scripts/power-user.js';
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
