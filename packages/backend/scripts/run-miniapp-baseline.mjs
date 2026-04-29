#!/usr/bin/env node
/**
 * Step 0.4 — miniAPP candidate baseline runner.
 *
 * Loads every case from
 *   packages/backend/test/fixtures/macros/cases/{index.json + *.json}
 * runs each through the ported macro engine
 *   (packages/backend/src/prompt-engine/**)
 * with the SAME determinism mocks the ST baseline runner uses, and
 * writes a candidate baseline JSON to
 *   packages/backend/test/fixtures/macros/baselines/miniapp-macros-YYYYMMDD-HHmm.json
 *
 * The output schema matches `schema/baseline.schema.json`:
 *
 *   { schemaVersion: "1.0",
 *     runMeta: { runAt, engine: "miniapp", stVersion, userAgent, notes, stepName: "macros" },
 *     results: [
 *       { caseId, input (verbatim), output: { text, meta: { macrosUsed, warnings, envSnapshot, error } } },
 *       ...
 *     ]
 *   }
 *
 * Diffing is done by a separate script (`diff-baselines.mjs`).
 *
 * Usage (from the backend package):
 *
 *   pnpm --filter @miniapp/backend exec node scripts/run-miniapp-baseline.mjs
 *
 * Notes:
 *   - This runner CALLS the ported MacroEnvBuilder + MacroEngine
 *     DIRECTLY (just like the ST runner does), instead of going through
 *     the public substituteParams.ts façade. That's because we need to
 *     capture the built MacroEnv for envSnapshot. The façade does
 *     setRuntimeCtx / setGlobalStore / cleanup the same way we do here.
 *   - We still inject a recursive substituteParams pointer through
 *     setRuntimeCtx so getCharacterCardFieldsLazy's baseChatReplace
 *     can recurse correctly (e.g. {{user}} / {{char}} inside mes_example).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

import {
  buildCtxFromCase,
  withDeterministicEnv,
  installDeterministicRandomShim,
  trackMacroUsage,
  captureConsole,
  snapshotMacroEnv,
} from './_lib/macro-baseline-helpers.mjs';

import { MacroEnvBuilder } from '../src/prompt-engine/macros/engine/MacroEnvBuilder.js';
import { MacroEngine } from '../src/prompt-engine/macros/engine/MacroEngine.js';
import { setRuntimeCtx, resetRuntimeCtx } from '../src/prompt-engine/macros/runtime/host.js';
import { setGlobalStore } from '../src/prompt-engine/macros/runtime/variables.js';
import { initRegisterMacros } from '../src/prompt-engine/macros/macro-system.js';
import { substituteParams } from '../src/prompt-engine/substituteParams.ts';

// ─── Paths ──────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_BACKEND = resolve(__dirname, '..');
const FIXTURES_DIR = resolve(REPO_BACKEND, 'test/fixtures/macros');
const CASES_DIR = resolve(FIXTURES_DIR, 'cases');
const BASELINES_DIR = resolve(FIXTURES_DIR, 'baselines');

const SCHEMA_VERSION = '1.0';
const ENGINE_LABEL = 'miniapp';

// ─── Boot the engine once ───────────────────────────────────────────────────

initRegisterMacros();

// ─── Per-case execution ─────────────────────────────────────────────────────

/**
 * Run one case through the engine and return its `output` slot.
 *
 * Determinism is enforced exactly like the ST baseline runner:
 *   1. installDeterministicRandomShim → swaps {{random}} handler
 *   2. withDeterministicEnv → seeds Math.random, pins moment.now
 *   3. trackMacroUsage → wraps MacroRegistry.executeMacro
 *   4. captureConsole → buffers macro warnings/errors
 *
 * @param {object} caseObj
 * @returns {Promise<{text: string, meta: object}>}
 */
async function runOneCase(caseObj) {
  const input = caseObj.input;
  const ctx = buildCtxFromCase(input);

  // Install a recursive substituteParams pointer so baseChatReplace
  // (called by host.js's getCharacterCardFieldsLazy) recurses through
  // the actual public façade, not a stub.
  const recursiveSubstitute = (s, opts = {}) => substituteParams(s, ctx, opts);

  // Patch host bindings + global var store. Mirrors what the façade
  // does internally — we just need to keep the env handle around.
  const hostSnapshot = setRuntimeCtx({
    chat: ctx.chat,
    chat_metadata: ctx.chatMetadata,
    main_api: ctx.mainApi,
    name1: ctx.name1,
    name2: ctx.name2,
    characters: ctx.characters,
    groups: ctx.groups ?? [],
    selected_group: ctx.selectedGroup ?? null,
    power_user: ctx.powerUser,
    extension_prompts: ctx.extensionPrompts,
    textgenerationwebui_banned_in_macros: ctx.bannedTokens,
    this_chid: ctx.thisChid,
    userInput: ctx.userInput ?? '',
    substituteParams: recursiveSubstitute,
    getCurrentChatId: ctx.getCurrentChatId,
    getGeneratingModel: ctx.getGeneratingModel,
    getMaxPromptTokens: ctx.getMaxPromptTokens,
    getMaxContextTokens: ctx.getMaxContextTokens,
    getMaxResponseTokens: ctx.getMaxResponseTokens,
  });
  const prevGlobalStore = setGlobalStore(ctx.globalVariables ?? {});

  /** @type {Set<string>} */
  const macrosUsed = new Set();
  const stopTracker = trackMacroUsage(macrosUsed);
  const restoreRandom = installDeterministicRandomShim(input.options?.seed ?? '');

  let env;
  let text = '';
  let warnings = [];
  let errorString = null;
  /** @type {Record<string, unknown>} */
  let envSnapshot = {};

  try {
    const wrapped = await captureConsole(() =>
      withDeterministicEnv(
        { seed: input.options?.seed ?? null, isoNow: input.options?.now ?? null },
        () => {
          const rawEnvCtx = {
            content: input.template,
            name1Override: input.options?.name1Override,
            name2Override: input.options?.name2Override,
            original: input.options?.original,
            groupOverride: input.options?.groupOverride,
            replaceCharacterCard: input.options?.replaceCharacterCard ?? true,
            dynamicMacros: input.options?.dynamicMacros ?? {},
            postProcessFn: (x) => x,
          };
          env = MacroEnvBuilder.buildFromRawEnv(rawEnvCtx);
          const result = MacroEngine.evaluate(input.template, env);
          // CRITICAL: snapshot the env WHILE host bindings are still
          // patched. env.character is a bag of lazy getters that
          // ultimately call _hostFns.substituteParams (for baseChatReplace)
          // and read name1/name2/characters off the host. If we wait
          // until finally — which calls resetRuntimeCtx — those reads
          // would see default globals, and {{user}}/{{char}} inside
          // mes_example would no longer be substituted (which is what
          // bit case 9's envSnapshot.character.mesExamplesRaw before).
          envSnapshot = snapshotMacroEnv(env);
          return result;
        }
      )
    );
    text = wrapped.result;
    // Match the ST runner: only keep warnings whose serialised form
    // mentions "macro" — drops unrelated console noise.
    warnings = wrapped.warnings.filter((w) => /macro/i.test(w));
  } catch (e) {
    errorString = e?.stack ?? String(e);
  } finally {
    restoreRandom();
    stopTracker();
    setGlobalStore(prevGlobalStore);
    resetRuntimeCtx(hostSnapshot);
  }

  return {
    text,
    meta: {
      macrosUsed: [...macrosUsed].sort(),
      warnings,
      envSnapshot,
      error: errorString,
    },
  };
}

// ─── Top-level driver ───────────────────────────────────────────────────────

async function loadCases() {
  const indexRaw = await readFile(resolve(CASES_DIR, 'index.json'), 'utf8');
  const index = JSON.parse(indexRaw);
  if (!Array.isArray(index?.cases)) {
    throw new Error(`Invalid index.json (no .cases array): ${CASES_DIR}/index.json`);
  }
  const out = [];
  for (const filename of index.cases) {
    const path = resolve(CASES_DIR, filename);
    const raw = await readFile(path, 'utf8');
    out.push(JSON.parse(raw));
  }
  return out;
}

function makeBaselineFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  return `${ENGINE_LABEL}-macros-${yyyy}${mm}${dd}-${hh}${mi}.json`;
}

function readPackageVersion() {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json');
    return `${pkg.name}@${pkg.version}`;
  } catch {
    return 'miniapp-backend@unknown';
  }
}

async function main() {
  const startedAt = new Date();
  const cases = await loadCases();
  console.log(`[run-miniapp-baseline] loaded ${cases.length} case(s) from ${CASES_DIR}`);

  const results = [];
  for (const caseObj of cases) {
    let output;
    try {
      output = await runOneCase(caseObj);
    } catch (e) {
      console.error(`[run-miniapp-baseline] case ${caseObj.caseId} threw outside the engine:`, e);
      output = {
        text: '',
        meta: {
          macrosUsed: [],
          warnings: [],
          envSnapshot: {},
          error: e?.stack ?? String(e),
        },
      };
    }
    const status = output.meta.error ? 'ERROR' : 'OK';
    console.log(`[run-miniapp-baseline] ${status.padEnd(5)} ${caseObj.caseId}`);
    results.push({
      caseId: caseObj.caseId,
      input: caseObj.input,
      output,
    });
  }

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    runMeta: {
      runAt: startedAt.toISOString(),
      engine: ENGINE_LABEL,
      stVersion: readPackageVersion(),
      userAgent: `Node.js ${process.version}`,
      notes:
        'Step 0.4 candidate: miniAPP-ported MacroEngine.evaluate over MacroEnvBuilder.buildFromRawEnv',
      stepName: 'macros',
    },
    results,
  };

  const filename = makeBaselineFilename(startedAt);
  const outPath = resolve(BASELINES_DIR, filename);
  await writeFile(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.log(`\n[run-miniapp-baseline] wrote ${outPath}`);
}

main().catch((e) => {
  console.error('[run-miniapp-baseline] fatal:', e);
  process.exit(1);
});
