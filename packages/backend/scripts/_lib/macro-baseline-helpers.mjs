/**
 * Shared helpers for the macro engine baseline tooling.
 *
 * Exists so `smoke-macros.mjs` (sanity check) and
 * `run-miniapp-baseline.mjs` (Step 0.4 candidate generator) stay in
 * lock-step on:
 *
 *   - case-fixture → ST-shaped character / chat conversion
 *   - case input → SubstituteCtx mapping
 *   - determinism mocks (Math.random / moment / {{random}} handler shim)
 *   - env snapshotting (matches the ST baseline runner's snapshotMacroEnv)
 *   - macrosUsed / warnings capture
 *
 * If you change anything here, update both tools and re-run the diff
 * against the ST baseline.
 */

import seedrandom from 'seedrandom';
import moment from 'moment';

// Internal access — this module is test/tooling only. The {{random}}
// handler shim mirrors what the ST baseline runner does, see
// test/baseline-runner/adapters/macros.js for the long explanation
// (seedrandom's entropy pool can't be reset from the outside).
import { MacroRegistry } from '../../src/prompt-engine/macros/engine/MacroRegistry.js';

// ─── Fixture → ST shape ─────────────────────────────────────────────────────

/**
 * Converts a case fixture's CharacterFields into the ST character
 * object shape that getCharacterCardFieldsLazy reads from.
 * Mirrors `caseToStCharacter` in test/baseline-runner/adapters/macros.js.
 */
export function caseToStCharacter(charFields = {}, chatId = 'baseline-chat') {
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

/**
 * Converts a case fixture's ChatMessage[] into the ST chat[] shape.
 * Mirrors `caseChatToStChat` in test/baseline-runner/adapters/macros.js.
 */
export function caseChatToStChat(messages = []) {
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

/**
 * Build a SubstituteCtx (the shape expected by `substituteParams(...)`)
 * from a single case's `input` block.
 *
 * IMPORTANT — match the ST runner exactly:
 *   - power_user.persona_description merges character.persona override
 *     onto user.personaDescription (character takes priority). This is
 *     what makes {{persona}} return the *character* persona in case 9.
 *   - chat_metadata.pick_reroll_seed is set from chatMetadata.pickRerollSeed
 *     (snake_case is ST's internal key).
 *   - thisChid points at the synthetic character (index 0 here, since
 *     each case runs with exactly one character in `characters[]`).
 */
export function buildCtxFromCase(input) {
  const character = caseToStCharacter(
    input.character ?? {},
    input.chatMetadata?.chatId ?? 'baseline-chat'
  );
  return {
    chat: caseChatToStChat(input.chat?.messages ?? []),
    chatMetadata: {
      ...(input.chatMetadata ?? {}),
      pick_reroll_seed: input.chatMetadata?.pickRerollSeed ?? null,
      variables: structuredClone(input.chatMetadata?.variables ?? {}),
    },
    mainApi: input.settings?.mainApi ?? '',
    name1: input.user?.name ?? '',
    name2: input.character?.name ?? '',
    characters: [character],
    thisChid: 0,
    powerUser: {
      persona_description: input.character?.persona ?? input.user?.personaDescription ?? '',
    },
    extensionPrompts: {},
    bannedTokens: [],
    globalVariables: {},
    userInput: '',
    getCurrentChatId: () => input.chatMetadata?.chatId ?? '',
    getMaxPromptTokens: () => input.settings?.maxPromptTokens ?? 0,
    getMaxContextTokens: () => input.settings?.maxContextTokens ?? 0,
    getMaxResponseTokens: () => input.settings?.maxResponseTokens ?? 0,
    getGeneratingModel: () => '',
  };
}

// ─── Determinism mocks ──────────────────────────────────────────────────────

/**
 * Wraps fn() so that for its duration:
 *   - Math.random is replaced by a seedrandom-driven generator (drives
 *     {{roll}} via droll's internal Math.random use).
 *   - moment.now returns the fixed timestamp (drives {{time}} / {{date}} / etc.).
 *   - moment.locale is pinned to 'en' for stable {{date}} / {{weekday}}.
 *
 * Restores all of the above in finally(), even on exception.
 *
 * Mirrors `withDeterministicEnv` in test/baseline-runner/harness.js.
 */
export async function withDeterministicEnv({ seed, isoNow }, fn) {
  const origRandom = Math.random;
  const origMomentNow = moment.now;
  const origLocale = moment.locale();
  try {
    if (seed) seedrandom(seed, { global: true });
    if (isoNow) {
      const fixedMs = Date.parse(isoNow);
      if (Number.isNaN(fixedMs)) throw new Error(`Invalid isoNow: ${isoNow}`);
      moment.now = () => fixedMs;
    }
    moment.locale('en');
    return await fn();
  } finally {
    Math.random = origRandom;
    moment.now = origMomentNow;
    moment.locale(origLocale);
  }
}

/**
 * Replaces the {{random}} macro handler with a deterministic, position-stable
 * version for the duration of one case. Returns a restore() callback.
 *
 * Mirrors `installDeterministicRandomShim` in
 * test/baseline-runner/adapters/macros.js. See the long explanation
 * there for *why* this is needed (short version: ST's stock {{random}}
 * calls seedrandom('added entropy.', { entropy: true }), which reads
 * from a closure-private entropy pool that no Math.random / crypto
 * mock can pin).
 */
export function installDeterministicRandomShim(caseSeed) {
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
 * Splits the legacy single-arg {{random}} list shape, mirroring ST's
 * private readSingleArgsRandomList in core-macros.js.
 */
export function readSingleArgsRandomList(listString) {
  if (listString.includes('::')) {
    return listString.split('::').map((item) => item.trim());
  }
  return listString
    .replace(/\\,/g, '##\uFFFDCOMMA\uFFFD##')
    .split(',')
    .map((item) => item.trim().replace(/##\uFFFDCOMMA\uFFFD##/g, ','));
}

// ─── Tracking ───────────────────────────────────────────────────────────────

/**
 * Wraps MacroRegistry.executeMacro to record every macro that was
 * actually invoked during evaluation. Returns a restore() callback.
 *
 * Mirrors `trackMacroUsage` in test/baseline-runner/adapters/macros.js.
 */
export function trackMacroUsage(sink) {
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
 * Captures console.warn / console.error into a string array during fn().
 * Mirrors `captureConsole` in test/baseline-runner/harness.js.
 */
export async function captureConsole(fn) {
  const warnings = [];
  const origWarn = console.warn;
  const origError = console.error;
  const sink =
    (level) =>
    (...args) => {
      try {
        warnings.push(`[${level}] ` + args.map(stringifyForLog).join(' '));
      } catch {
        /* swallow */
      }
    };
  console.warn = sink('warn');
  console.error = sink('error');
  try {
    const result = await fn();
    return { result, warnings };
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }
}

function stringifyForLog(v) {
  if (v instanceof Error) return v.stack ?? v.message;
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

// ─── Env snapshot ───────────────────────────────────────────────────────────

/**
 * JSON-safe snapshot of a MacroEnv with character lazy getters resolved.
 * Mirrors `snapshotMacroEnv` in test/baseline-runner/adapters/macros.js.
 */
export function snapshotMacroEnv(env) {
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

/**
 * Recursively converts an object into a JSON-safe form: drops
 * functions, resolves lazy getters via property access, breaks cycles
 * with "[Circular]". Mirrors `snapshotJsonSafe` in
 * test/baseline-runner/harness.js.
 */
export function snapshotJsonSafe(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'function') return undefined;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => snapshotJsonSafe(v, seen));

  const out = {};
  for (const key of Object.keys(value)) {
    let v;
    try {
      v = value[key];
    } catch (e) {
      v = `[Throws: ${e?.message ?? e}]`;
    }
    const safe = snapshotJsonSafe(v, seen);
    if (safe !== undefined) out[key] = safe;
  }
  return out;
}
